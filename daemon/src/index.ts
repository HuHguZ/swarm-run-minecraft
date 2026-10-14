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

function statusDetail (p) {
  return {
    fairPlay: cfg.fairPlay,
    server: `${cfg.host}:${cfg.port}`,
    ...(p?.swarm ? { sightings: require('./swarm-senses').swarmSightings(session.bot, p.swarmAllies), ownEnchants: enchantedGear(session.bot) } : {}),
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
    // Летящие вредные зелья и игроки со взрывным зельем в руке (threats.dangers) — арене для уворота.
    ...(p && p.dangers && session.bot?.entity ? { dangers: require('./threats').dangers(session.bot, { foes: p.foes ?? dangerWatch?.foes }) } : {}),
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
  }
}

// Слежка за угрозами для арены (12.10, уворот от булавы и зелий): опрос драйвера раз в 250 мс опаздывал на падение
// и бросок; включённая — шлёт { type: 'danger' } подключённому мозгу сразу, как тело увидело угрозу (раз в 50 мс).
const methods = {
  status: async (p) => session.immediate(async () => statusDetail(p)),
  // Наблюдатель сцены рядом с работающей кампанией: состояние и враги рядом БЕЗ выемки шины событий
  // (status/situation через immediate() забирают события у мозга — emergency/refuge/damage пропадали бы).
  peek: async (p) => {
    const bot = session.bot
    let foes = []
    try { if (bot && bot.entity) foes = require('./flee').hostilesAround(bot, 24).slice(0, 8).map(h => ({ name: h.e.name, d: Math.round(h.d * 10) / 10, dy: Math.round((h.e.position.y - bot.entity.position.y) * 10) / 10 })) } catch {}
    return { status: 'done', detail: { ...statusDetail(p), foes, busy: session.current ? session.current.name : null, refuging: !!(session.autopilot && session.autopilot.refuging) }, events: [], state: session.state() }
  },
  // Залить лаву водой и забрать воду (12.10, арена: «лаву водой — заранее»): вода в клетку лавы (ведро целится в верх
  // блока под ней — obsidian.pourOnto), источник рядом с водой застывает; через 0.5 с ведро назад.
  douse_lava: async (p: any = {}) => session.runIntent('douse_lava', async () => {
    const bot = session.require()
    const o = require('./obsidian')
    const Vec3 = require('vec3')
    if (!p.at) throw new Error('нужна точка at')
    const at = new Vec3(p.at.x, p.at.y, p.at.z).floored()
    if (bot.entity.position.offset(0, 1.62, 0).distanceTo(at.offset(0.5, 0.5, 0.5)) > 4.5) return { ok: false, why: 'далеко' }
    if (!bot.inventory.items().some(i => i.name === 'water_bucket')) return { ok: false, why: 'нет ведра воды' }
    const ok = await o.pourOnto(bot, at.offset(0, -1, 0))
    if (ok) { await gameClock.sleep(500); await o.scoopWater(bot, at) }
    return { ok, why: ok ? 'залил' : 'не вылилась' }
  }, { timeoutMs: 4000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
  // Рывок уворота (12.10: «уворачиваясь — бегать и прыгать, а не шагать»): развернуться в сторону ухода, спринт и прыжки
  // ticks тиков, без поиска пути. Перед рывком — 3 клетки по ходу: без лавы/огня и с полом не глубже 4 бл.; опасно —
  // назад или вбок.
  evade: async (p: any = {}) => session.runIntent('evade', async (ctl) => {
    const bot = session.require()
    const n = Math.hypot(p.dir?.x || 0, p.dir?.z || 0)
    if (!n) return { ok: false, why: 'нет направления' }
    // Куда бежать — с учётом стен (12.10: «уворачиваясь, бежит в стенку и упирается — геометрию не считает»): 8 направлений
    // от желаемого, по каждому — чистый пробег тела до 4 бл. (flee.runLength: стены и ширина тела, подъём на блок с местом
    // над головой, обрыв не глубже 3, лава/огонь); короче 2 — нельзя. Цена: уклон от желаемого, недобег, замкнутость конца.
    const fl = require('./flee')
    // В воде рывка нет (13.10: «застрял в воде — я его просто расстреливал»): сначала к берегу.
    const mv = require('./movement')
    if (mv.inWater(bot)) { const w = await mv.escapeWater(bot, ctl, { timeoutMs: 5000 }).catch(() => null); return { ok: !!w?.ok, why: w?.ok ? 'выплыл' : 'в воде, к берегу не вышло' } }
    const base = Math.atan2(p.dir.z / n, p.dir.x / n)
    const all = [0, 1, -1, 2, -2, 3, -3, 4].map(k => {
      const a = base + k * Math.PI / 4
      const dir = { x: Math.cos(a), z: Math.sin(a) }
      // До 6 бл.: из брызг зелья (радиус 4) за один рывок.
      const run = fl.runLength(bot, dir, 6, 3, p.arena)
      return { dir, run, c: Math.abs(k) * 2 + (6 - run.len) * 2 + (run.len >= 2 ? fl.enclosure(bot, run.end) * 0.5 : 0) }
    })
    // Тесно (галерея, лестница, гребень Колизея; 13.10: «зелья кидаю — стоят»: 19 раз «некуда» за 3 мин): годится и шаг
    // в 1 бл.; совсем некуда, а dropOk (зелье, булава) — спрыгнуть до 6 бл.: падение дешевле вреда II.
    let pickFrom = all.filter(o => o.run.len >= 2)
    if (!pickFrom.length) pickFrom = all.filter(o => o.run.len >= 1)
    if (!pickFrom.length && p.dropOk) pickFrom = all.map(o => ({ ...o, run: fl.runLength(bot, o.dir, 6, 6, p.arena) })).filter(o => o.run.len >= 1)
    const cands = pickFrom.sort((a, b) => a.c - b.c)
    if (!cands.length) {
      // Яма (13.10: «проваливаются в яму с сундуком — лечу на них, вылезти не успевают»): над головой свободно — вверх:
      // заряд ветра под ноги в прыжке (подброс ~7 бл.), нет — прыжок и свой блок под ноги.
      const head = bot.blockAt(bot.entity.position.offset(0, 2, 0))
      if (head && head.boundingBox === 'empty') {
        const wc = bot.inventory.items().find(i => i.name === 'wind_charge')
        try { if (bot.usingHeldItem) bot.deactivateItem() } catch {}
        if (wc) {
          await bot.equip(wc, 'hand')
          bot.setControlState('jump', true); await bot.waitForTicks(2); bot.setControlState('jump', false)
          await bot.look(bot.entity.yaw, -Math.PI / 2, true); bot.activateItem(); await bot.waitForTicks(6)
          return { ok: true, how: 'ветром из ямы' }
        }
        const c0 = bot.entity.position.floored()
        bot.setControlState('jump', true); await bot.waitForTicks(5); bot.setControlState('jump', false)
        const r = await require('./build').placeBlockAt(bot, c0, { honest: true, timeoutMs: 1000, ctl }).catch(() => null)
        if (r?.ok) return { ok: true, how: 'блок под себя' }
      }
      return { ok: false, why: 'некуда: стены, обрыв или лава со всех сторон' }
    }
    let dx = cands[0].dir.x; let dz = cands[0].dir.z
    bot.pathfinder?.setGoal(null)
    // Ел/пил — бросить: с едой у рта бег вдвое медленнее.
    try { if (bot.usingHeldItem) bot.deactivateItem() } catch {}
    // Смотреть — на угрозу (look: стрелок, падающий, зелье; 12.10: «уворачиваются, глядя в стенку — смотреть на объект,
    // в сторону — только когда бегут туда»): клавиши — относительно взгляда, спринт — только при беге вперёд. Без look —
    // взгляд по ходу (уход из облака, от лавы).
    const look = p.look && Number.isFinite(p.look.x) ? new (require('vec3'))(p.look.x, p.look.y, p.look.z) : null
    const keys = () => {
      const yaw = bot.entity.yaw
      const fwd = -Math.sin(yaw) * dx - Math.cos(yaw) * dz
      const side = Math.cos(yaw) * dx - Math.sin(yaw) * dz
      bot.setControlState('forward', fwd > 0.38); bot.setControlState('back', fwd < -0.38)
      bot.setControlState('right', side > 0.38); bot.setControlState('left', side < -0.38)
      bot.setControlState('sprint', fwd > 0.38)
    }
    if (look) await bot.lookAt(look, true); else await bot.look(Math.atan2(-dx, -dz), 0, true)
    // Не дольше чистого пробега (≈0.3 бл/тик спринтом): дальше runLength не смотрел — там может быть стена.
    const ticks = Math.max(3, Math.min(30, Math.round(p.ticks ?? 10), Math.ceil(cands[0].run.len / 0.3)))
    try {
      for (let t = 0; t < ticks && !ctl.aborted; t++) {
        if (look) bot.lookAt(look, true).catch(() => {})
        if (!fl.insideArena(bot.entity.position.offset(dx, 0, dz), p.arena)) break
        keys()
        bot.setControlState('jump', !!p.jump && !!bot.entity.onGround)
        await gameClock.sleep(50)
      }
    } finally { bot.clearControlStates() }
    return { ok: true, dir: { x: Math.round(dx * 100) / 100, z: Math.round(dz * 100) / 100 } }
  }, { timeoutMs: 3000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
  // Джук под прицелом (12.10, арена: «целюсь из лука — стоят; стрейфить, прыгать, заранее, как только нацеливаюсь»;
  // замер farm/arena-archer-test: рывки по 0.3 с с паузами — 80 % попаданий с 8 бл.). Пока стрелок (from) целится в меня
  // или летит его стрела — без пауз зигзаг поперёк линии на него: отрезки случайной длины (3–9 тиков), сторона меняется
  // случайно (не строго через раз — упреждение человека не угадает), по стенам — flee.runLength (упёрся — в другую
  // сторону или назад от него). Взгляд — на стрелка; прыжки — с долей jumpy. Летит стрела — сразу поперёк её хода.
  // retreat — уходить от него (зигзагом назад): ответить нечем. Конец — прицела нет 6 тиков подряд или maxTicks.
  juke: async (p: any = {}) => session.runIntent('juke', async (ctl) => {
    const bot = session.require()
    const V = require('vec3'); const fl = require('./flee'); const th = require('./threats')
    const name = String(p.from || '')
    const maxTicks = Math.max(10, Math.min(200, Math.round(p.maxTicks ?? 80)))
    try { if (bot.usingHeldItem) bot.deactivateItem() } catch {}
    const jumpy = Number.isFinite(p.jumpy) ? p.jumpy : 0.6
    bot.pathfinder?.setGoal(null)
    const mvw = require('./movement')
    if (mvw.inWater(bot)) await mvw.escapeWater(bot, ctl, { timeoutMs: 5000 }).catch(() => null)
    let side = Math.random() < 0.5 ? 1 : -1; let segLeft = 0; let dx = 0; let dz = 0; let quiet = 0; let t = 0; let segs = 0
    const sight = require('./pvp/last-seen').createLastSeen(bot)
    let shooter = sight.observe(bot.players[name]?.entity)
    const keys = () => {
      const yaw = bot.entity.yaw
      const fwd = -Math.sin(yaw) * dx - Math.cos(yaw) * dz
      const sd = Math.cos(yaw) * dx - Math.sin(yaw) * dz
      bot.setControlState('forward', fwd > 0.38); bot.setControlState('back', fwd < -0.38)
      bot.setControlState('right', sd > 0.38); bot.setControlState('left', sd < -0.38)
      bot.setControlState('sprint', fwd > 0.38)
    }
    try {
      for (; t < maxTicks && !ctl.aborted; t++) {
        shooter = sight.observe(bot.players[name]?.entity) || shooter
        if (!shooter || !sight.visible(shooter)) break
        const me = bot.entity.position
        const d = th.dangers(bot, { foes: [name], radius: 64 })
        const aimed = d.aims.some(a => a.name === name); const arrow = d.arrows[0]
        quiet = aimed || arrow ? 0 : quiet + 1
        if (quiet >= 6) break
        let ax = shooter.position.x - me.x; let az = shooter.position.z - me.z; const L = Math.hypot(ax, az) || 1; ax /= L; az /= L
        if (arrow && arrow.side) { dx = arrow.side.x; dz = arrow.side.z; segLeft = 4 }
        else if (segLeft <= 0) {
          if (Math.random() < 0.65) side = -side
          let px = -az * side; let pz = ax * side
          if (p.retreat) { px = px * 0.6 - ax * 0.8; pz = pz * 0.6 - az * 0.8 }
          const n = Math.hypot(px, pz) || 1; px /= n; pz /= n
          // Упёрся бы в стену/обрыв — другая сторона, потом назад от стрелка.
          const opts = [[px, pz], [-px, -pz], [-ax, -az]]
          const ok = opts.find(([x, z]) => fl.runLength(bot, { x, z }, 2, 3, p.arena).len >= 1.2)
          if (!ok) break
          ;[dx, dz] = ok; segLeft = 3 + Math.floor(Math.random() * 7); segs++
          if (bot.entity.onGround && Math.random() < jumpy) bot.setControlState('jump', true)
        }
        if (!fl.insideArena(me.offset(dx, 0, dz), p.arena)) break
        bot.lookAt(shooter.position.offset(0, 1.6, 0), true).catch(() => {})
        keys()
        if (!bot.entity.onGround) bot.setControlState('jump', false)
        segLeft--
        await gameClock.sleep(50)
      }
    } finally { sight.close(); bot.clearControlStates() }
    return { ok: true, ticks: t, segments: segs }
  }, { timeoutMs: 15000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
  // Укрыться от стрелка (12.10, арена: «когда целюсь сверху — забегать под меня»; «блоками заставиться, чтобы стрелы не
  // убивали»): клетка в maxRun бл., откуда его глаз не видно (луч perception.raySees: под стену, на которой он стоит, за
  // выступ), спуск не больше 4, — бегом (movement.travelXZ); нет такой или не дошёл — стена из своих блоков на линии
  // огня в клетке к нему, снизу вверх (опора — пол), до 3 в высоту, если он выше; ставит честно, пока луч не закрыт.
  take_cover: async (p: any = {}) => session.runIntent('take_cover', async (ctl) => {
    const bot = session.require()
    const V = require('vec3'); const { raySees, eyePos } = require('./perception')
    const { standableY, travelXZ } = require('./movement'); const { placeBlockAt, pickFiller } = require('./build')
    const foe = bot.players[String(p.from || '')]?.entity
    if (!foe || !require('./pvp/last-seen').seesPlayer(bot, foe)) return { ok: false, why: 'не вижу его' }
    if (p.arena) return require('./flee').smartFlee(session, ctl, { foes: [foe.id], arena: p.arena, timeoutMs: 3000, reason: 'ищу укрытие от видимой угрозы' })
    const eye = () => foe.position.offset(0, 1.62, 0)
    const seen = () => raySees(bot, eyePos(bot), eye())
    if (!seen()) return { ok: true, how: 'уже не видно' }
    bot.pathfinder?.setGoal(null)
    const me = bot.entity.position; const f0 = me.floored()
    const maxRun = Math.max(2, Math.min(12, p.maxRun ?? 7))
    const spots = []
    for (let r = 1; r <= maxRun; r++) {
      const n = Math.max(8, Math.round(r * 6))
      for (let k = 0; k < n; k++) {
        const a = k / n * 2 * Math.PI
        const x = Math.floor(me.x + Math.cos(a) * r); const z = Math.floor(me.z + Math.sin(a) * r)
        if (spots.some(o => o.x === x && o.z === z)) continue
        const y = standableY(bot, x, f0.y, z)
        if (y == null || y < f0.y - 4 || y > f0.y + 1) continue
        if (raySees(bot, new V(x + 0.5, y + 1.62, z + 0.5), eye()) || raySees(bot, new V(x + 0.5, y + 0.9, z + 0.5), eye())) continue
        spots.push({ x, y, z, r })
      }
      if (spots.length >= 4) break
    }
    const tried = []
    for (const sp of spots.slice(0, 3)) {
      if (ctl.aborted) break
      const run = await travelXZ(bot, ctl, sp.x + 0.5, sp.z + 0.5, { range: 0.5, retries: 0, y: sp.y, deadline: gameClock.now() + 1200 + sp.r * 350 }).catch(e => ({ ok: false, error: e.message }))
      tried.push(`${sp.x},${sp.y},${sp.z}${run.ok ? '' : ' ✗'}`)
      if (!seen()) return { ok: true, how: 'укрытие', at: sp, tried }
    }
    if (p.blocks === false || !pickFiller(bot)) return { ok: false, why: spots.length ? 'не добежал до укрытия' : 'укрытия нет, блоков нет', tried }
    // Стена: клетка к нему (по большей оси), снизу вверх; он выше на 35°+ — третий блок.
    const here = bot.entity.position; const ff = here.floored()
    const dx = foe.position.x - here.x; const dz = foe.position.z - here.z
    const step = Math.abs(dx) >= Math.abs(dz) ? new V(Math.sign(dx), 0, 0) : new V(0, 0, Math.sign(dz))
    const steep = (foe.position.y - here.y) / (Math.hypot(dx, dz) || 1) > 0.7
    let placed = 0
    for (const h of steep ? [0, 1, 2] : [0, 1]) {
      if (ctl.aborted) break
      const c = ff.plus(step).offset(0, h, 0)
      const b = bot.blockAt(c)
      if (b && b.boundingBox === 'block') continue
      const r = await placeBlockAt(bot, c, { honest: true, timeoutMs: 1000, ctl }).catch(() => null)
      if (r?.ok && !r.already) placed++
      if (!seen()) return { ok: true, how: `стена ${placed}`, tried }
    }
    return { ok: false, why: `стена ${placed}, луч открыт`, tried }
  }, { timeoutMs: 8000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
  // Долететь на элитрах и сесть рядом с целью (12.10, арена: «на элитрах не могут залететь ко мне — садиться в любую
  // точку, к игроку, и бить»): клетка посадки — свободная, с полом без лавы/воды в 1.5–3.5 бл. от цели; элитры — на
  // тело (нагрудник после посадки назад); маршрут — ворота над серединой пути и посадка (combat/flight-route).
  fly_to: async (p: any = {}) => session.runIntent('fly_to', async (ctl) => {
    const bot = session.require()
    const sky = require('./elytra')
    const Vec3 = require('vec3')
    if (!p.at) throw new Error('нужна точка at')
    const k = sky.kit(bot)
    if (!k.elytra || k.rockets < 2) return { ok: false, why: 'нет элитр или ракет' }
    const W = sky.worldOf(bot, { observed: !!p.arena })
    const t = new Vec3(p.at.x, p.at.y, p.at.z)
    const inside = at => require('./combat/team-wind').windInside(at, p.arena)
    if (!inside(t) || !inside(bot.entity.position)) return { ok: false, why: 'outside_arena' }
    // Гребень на линии полёта (13.10: «летят ко мне сквозь стену Колизея, бьются, получают урон и уходят — облёт надо
    // считать»): верх твёрдого в колонках вдоль прямой (шаг 1 бл., без 2 бл. у старта и у цели; непрогруженное — твёрдое).
    // Высота полёта — над гребнем +4 (не ниже +8 над концами); посадка — только с открытым небом до этой высоты (в нишу
    // под навесом на элитрах не сесть — тогда отказ, пусть идёт пешком/копает).
    const me0 = bot.entity.position
    const yHi = Math.floor(Math.max(me0.y, t.y)) + 48; const yLo = Math.floor(Math.min(me0.y, t.y)) - 2
    const topAt = (x, z) => { for (let y = yHi; y >= yLo; y--) if (W.solid(Math.floor(x), y, Math.floor(z))) return y + 1; return yLo }
    const H0 = Math.hypot(t.x - me0.x, t.z - me0.z)
    let ridge = { y: -Infinity, x: (me0.x + t.x) / 2, z: (me0.z + t.z) / 2, d: H0 / 2 }
    for (let d = 2; d <= H0 - 2; d += 1) {
      const x = me0.x + (t.x - me0.x) * d / H0; const z = me0.z + (t.z - me0.z) * d / H0
      const y = topAt(x, z); if (y > ridge.y) ridge = { y, x, z, d }
    }
    const cruise = Math.max(ridge.y + 4, Math.max(me0.y, t.y) + 8)
    if (cruise > yHi) return { ok: false, why: 'гребень выше 48 бл. — не перелететь' }
    const skyOpen = (x, y0, z) => { for (let y = Math.floor(y0) + 2; y <= cruise; y++) if (W.solid(Math.floor(x), y, Math.floor(z))) return false; return true }
    let landing = null
    for (const r of [1.5, 2.5, 3.5]) for (let a = 0; a < 8 && !landing; a++) {
      const x = Math.floor(t.x + Math.cos(a * Math.PI / 4) * r) + 0.5; const z = Math.floor(t.z + Math.sin(a * Math.PI / 4) * r) + 0.5
      for (const dy of [0, 1, -1]) {
        const fl = W.floorBelow(x, Math.floor(t.y) + dy, z, 2)
        if (fl && !fl.lava && !fl.water && inside({ x, y: fl.top, z }) && Math.abs(fl.top - t.y) <= 1.5 && !W.boxHit(x, fl.top, z, 1.8) && skyOpen(x, fl.top, z)) { landing = { x, y: fl.top, z }; break }
      }
      if (landing) break
    }
    // У цели навес (галерея, ниша) — сесть на ближайшую открытую площадку до 8 бл. (на 3 ниже — на 10 выше цели) и дойти
    // пешком (13.10: «сижу в нычке под навесом — ни один не прилетел»).
    let walkIn = false
    if (!landing) {
      let best = null
      for (let r = 2; r <= 8; r++) for (let a = 0; a < 16; a++) {
        const x = Math.floor(t.x + Math.cos(a * Math.PI / 8) * r) + 0.5; const z = Math.floor(t.z + Math.sin(a * Math.PI / 8) * r) + 0.5
        const fl = W.floorBelow(x, Math.floor(t.y) + 10, z, 14)
        if (!fl || fl.lava || fl.water || !inside({ x, y: fl.top, z }) || fl.top < t.y - 3 || fl.top > t.y + 10 || W.boxHit(x, fl.top, z, 1.8) || !skyOpen(x, fl.top, z)) continue
        const c = r + Math.abs(fl.top - t.y) * 0.7
        if (!best || c < best.c) best = { c, x, y: fl.top, z }
      }
      if (best) { landing = { x: best.x, y: best.y, z: best.z }; walkIn = true }
    }
    if (!landing) return { ok: false, why: 'негде сесть у цели (под навесом или занято)' }
    if (!sky.wearingElytra(bot)) {
      // В падении клик инвентаря сервер иногда не принимает — ещё раз через тик.
      let sw = await sky.swapChest(bot, 'elytra', { hand: 'main' })
      if (!sw.ok && !bot.entity.onGround) { await bot.waitForTicks(1); sw = await sky.swapChest(bot, 'elytra', { hand: 'main' }) }
      if (!sw.ok) return { ok: false, why: 'элитры: ' + sw.why }
    }
    // В падении (спасение из пропасти) — раскрыть сразу; маршрут дальше без взлёта с земли (runFlightRoute: уже летим).
    if (!bot.entity.onGround && !sky.gliding(bot.entity)) sky.startGlide(bot)
    const me = bot.entity.position
    const h = Math.hypot(landing.x - me.x, landing.z - me.z)
    const along = h > 2 ? { x: landing.x - me.x, y: 0, z: landing.z - me.z } : { x: 0, y: 1, z: 0 }
    // Ворота: гребень близко к старту (взлёт круче 1:1) — сначала подъём над собой; потом — над гребнем на высоте полёта.
    const gates: any[] = []
    if (ridge.d < cruise - me.y) gates.push({ id: 'подъём', center: { x: me.x, y: cruise, z: me.z }, normal: { x: 0, y: 1, z: 0 }, radius: 5 })
    gates.push({ id: 'над гребнем', center: { x: ridge.x, y: cruise, z: ridge.z }, normal: along, radius: 4 })
    let r: any = null
    try { r = await require('./combat/flight-route').runFlightRoute(session, ctl, { gates, landing, timeoutSeconds: p.timeoutSeconds ?? 20, arena: p.arena }) } catch (e: any) { r = { ok: false, stopped: e.message } }
    try { if (!sky.gliding(bot.entity) && sky.wearingElytra(bot)) await sky.swapChest(bot, 'chest') } catch {}
    // Дальше пешком — боем драйвера (fight сам идёт к цели); goto отсюда ждал бы конца этого же полёта.
    return { ok: !!r?.ok, walkIn, why: r?.stopped || null, landing, ridge: Math.round(ridge.y), cruise: Math.round(cruise), hp: r?.hpBefore != null ? Math.round(r.hpBefore - r.hp) : null }
  }, { timeoutMs: ((p.timeoutSeconds ?? 20) + 10) * 1000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
  // Подкоп к цели по прямой (13.10, арена: «если путь не находится — пусть тупо в прямую копают ко мне тоннель»): шаг по
  // большей из осей к цели (по очереди — почти прямая линия); цель выше — ступенька вверх (над головой и впереди на две
  // клетки), ниже — вниз; под ногами впереди пусто — свой блок (build.placeBlockAt, честно). Копает только клетки перед
  // собой (видно прицелом), лучшим инструментом (tools.install: bot.dig). Лава или вода у вскрытой клетки — стоп.
  // Итог: { ok, steps, dug, placed, why, at }; ok — дошёл до 2.5 бл. от цели.
  swarm_work: async (p: any = {}) => session.runIntent('swarm_work', ctl => require('./actions').swarmWork(session, ctl, p), { interruptOn: ['death', 'kicked', 'disconnected'] }),
  swarm_hold: async (p: any = {}) => session.runIntent('swarm_hold', ctl => require('./swarm-position-work').swarmHold(session, ctl, p), { timeoutMs: 5000, interruptOn: ['death', 'kicked', 'disconnected'] }),
  swarm_pillar: async (p: any = {}) => session.runIntent('swarm_pillar', ctl => require('./swarm-position-work').swarmPillar(session, ctl, p), { timeoutMs: 30000, interruptOn: ['death', 'kicked', 'disconnected'] }),
  swarm_keep: async (p: any = {}) => session.immediate(async () => {
    if (p.cells !== undefined && (!Array.isArray(p.cells) || p.cells.length > 4096)) return { ok: false, why: 'invalid_cells' }
    return { ok: true, kept: require('./swarm-work').keepBlocks(session.require(), p.cells || [], { clear: p.clear === true }) }
  }),
  swarm_pose: async (p: any = {}) => session.immediate(async () => {
    const bot = session.require(), V = require('vec3')
    if (!p.at || ![p.at.x, p.at.y, p.at.z].every(Number.isSafeInteger)) return { poses: [] }
    const at = new V(p.at.x, p.at.y, p.at.z), seen = require('./pick').blockSeen(bot, at, { range: 64 })
    const block = seen && bot.blockAt(at), solid = block && !require('./navigation/geometry').HAZARD.test(block.name) && block.shapes?.some(s => s.every((n, i) => n === (i < 3 ? 0 : 1)))
    return { poses: p.inspectOnly ? [] : require('./swarm-senses').placementPoses(bot, p.at), ...(block ? { existing: { name: block.name, solid: !!solid } } : {}) }
  }),
  swarm_position: async (p: any = {}) => session.immediate(async () => {
    const bot = session.require()
    return require('./swarm-position').swarmPositions(bot, p)
  }),
  ledge_to: async (p: any = {}) => session.runIntent('ledge_to', ctl => require('./navigation/parkour').ledgeTo(session, ctl, p), { timeoutMs: Math.max(1, Math.min(20, p.timeoutSeconds ?? 8)) * 1000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
  wind_receive: async (p: any = {}) => session.runIntent('wind_receive', ctl => require('./combat/team-wind').windReceive(session, ctl, p), { timeoutMs: 10000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
  wind_boost: async (p: any = {}) => session.runIntent('wind_boost', ctl => require('./combat/team-wind').windBoost(session, ctl, p), { timeoutMs: 10000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
  dig_to: async (p: any = {}) => session.runIntent('dig_to', async (ctl) => {
    const bot = session.require()
    const V = require('vec3'); const { placeBlockAt } = require('./build')
    if (!p.at) throw new Error('нужна точка at')
    const T = new V(p.at.x, p.at.y, p.at.z)
    const maxSteps = Math.max(1, Math.min(80, p.maxSteps ?? 40))
    bot.pathfinder?.setGoal(null)
    const isAir = (v) => { const b = bot.blockAt(v); return !!b && b.boundingBox === 'empty' && !/^(water|lava)$/.test(b.name) }
    const wet = (v) => { for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]]) { const b = bot.blockAt(v.offset(d[0], d[1], d[2])); if (b && /^(water|lava)$/.test(b.name)) return b.name } return null }
    let steps = 0; let dug = 0; let placed = 0; let stuck = 0; let flip = false; let why = null
    const open = async (v) => {
      if (isAir(v)) return true
      const b = bot.blockAt(v)
      if (!b || b.name === 'bedrock' || b.diggable === false) return false
      const w = wet(v); if (w) { why = `${w} за стенкой`; return false }
      try { await bot.lookAt(v.offset(0.5, 0.5, 0.5), true); await bot.dig(b, true); dug++ } catch { return false }
      return isAir(v)
    }
    while (steps < maxSteps && !ctl.aborted) {
      const me = bot.entity.position; const c = me.floored()
      if (me.distanceTo(T) <= 2.5) return { ok: true, steps, dug, placed, at: c }
      const dx = T.x - me.x; const dz = T.z - me.z; const dy = Math.floor(T.y) - c.y
      // Ось шага: большая по остатку; при почти равных — по очереди.
      const useX = Math.abs(Math.abs(dx) - Math.abs(dz)) < 1 ? (flip = !flip) : Math.abs(dx) > Math.abs(dz)
      const st = Math.hypot(dx, dz) < 0.8 ? new V(0, 0, 0) : useX ? new V(Math.sign(dx), 0, 0) : new V(0, 0, Math.sign(dz))
      const up = dy >= 1; const down = dy <= -1 && !(st.x === 0 && st.z === 0)
      const nx = c.plus(st)
      let need: any[]; let feet
      if (st.x === 0 && st.z === 0) {
        // Цель прямо надо мной/подо мной: столб вверх (блок под ноги в прыжке) или копать вниз.
        if (dy >= 1) {
          if (!(await open(c.offset(0, 2, 0)))) { why = why || 'над головой не пробить'; break }
          bot.setControlState('jump', true); await bot.waitForTicks(6); bot.setControlState('jump', false)
          const r = await placeBlockAt(bot, c, { honest: true, timeoutMs: 1500, ctl }).catch(() => null)
          if (r?.ok) placed++; steps++; await bot.waitForTicks(4); continue
        }
        if (!(await open(c.offset(0, -1, 0)))) { why = why || 'под ногами не пробить'; break }
        await bot.waitForTicks(8); steps++; continue
      }
      if (up) { need = [c.offset(0, 2, 0), nx.offset(0, 1, 0), nx.offset(0, 2, 0)]; feet = nx.offset(0, 1, 0) }
      else if (down) { need = [nx, nx.offset(0, 1, 0), nx.offset(0, -1, 0)]; feet = nx.offset(0, -1, 0) }
      else { need = [nx, nx.offset(0, 1, 0)]; feet = nx }
      let ok = true
      for (const v of need) if (!(await open(v))) { ok = false; break }
      if (!ok) { if (++stuck >= 3) { why = why || 'не пробить'; break } flip = !flip; continue }
      // Пол под новой клеткой: пусто — свой блок (не в пропасть).
      const floor = feet.offset(0, -1, 0)
      if (isAir(floor)) {
        const r = await placeBlockAt(bot, floor, { honest: true, timeoutMs: 1500, ctl }).catch(() => null)
        if (r?.ok) placed++; else { why = 'под ногами пусто, блоков нет'; break }
      }
      // Шаг в клетку: лицом к ней, вперёд (вверх — с прыжком), до 20 тиков.
      const goal = feet.offset(0.5, 0, 0.5)
      for (let t = 0; t < 20 && !ctl.aborted; t++) {
        const pos = bot.entity.position
        if (pos.floored().x === feet.x && pos.floored().z === feet.z && Math.abs(pos.y - feet.y) < 0.6) break
        await bot.lookAt(goal.offset(0, 1.6, 0), true)
        bot.setControlState('forward', true); bot.setControlState('jump', up && bot.entity.onGround)
        await bot.waitForTicks(1)
      }
      bot.clearControlStates()
      const moved = !bot.entity.position.floored().equals(c)
      stuck = moved ? 0 : stuck + 1
      if (stuck >= 3) { why = 'не шагнуть'; break }
      steps++
    }
    bot.clearControlStates()
    const at = bot.entity.position.floored()
    return { ok: bot.entity.position.distanceTo(T) <= 2.5, steps, dug, placed, why, at: { x: at.x, y: at.y, z: at.z } }
  }, { timeoutMs: Math.max(10, Math.min(120, p.timeoutSeconds ?? 60)) * 1000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
  // Прыжок на заряде ветра в точку (wind-leap.ts): to — клетка, куда встать (ноги); dryRun — только план.
  wind_leap: async (p: any = {}) => session.runIntent('wind_leap', async (ctl) => {
    session.require()
    if (p.toward) return require('./wind-leap').leapToward(session, ctl, p.toward, { dryRun: !!p.dryRun, arena: p.arena })
    if (!p.to) throw new Error('нужна точка to или toward')
    return require('./wind-leap').leap(session, ctl, p.to, { dryRun: !!p.dryRun, arena: p.arena })
  }, { timeoutMs: 10000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
  // Выбить опору из-под него (13.10, арена: «стою прямо над ними — не ломают блоки, чтобы меня скинуть»): блоки под его
  // рамкой (ноги −0.5, по углам рамки ±0.3), видимые мне и в досягаемости 4.5 от глаз (pick.blockSeen — честно, не сквозь
  // стену), копаются лучшим инструментом (tools.install: bot.dig). Итог: { ok, dug, why }.
  undercut: async (p: any = {}) => session.runIntent('undercut', async (ctl) => {
    const bot = session.require()
    const V = require('vec3'); const pk = require('./pick')
    const foe = bot.players[String(p.target || '')]?.entity
    if (!foe) return { ok: false, why: 'не вижу его' }
    let dug = 0
    for (let pass = 0; pass < 3 && !ctl.aborted; pass++) {
      const f = foe.position
      const cells = new Map()
      for (const [ox, oz] of [[0, 0], [0.3, 0.3], [-0.3, 0.3], [0.3, -0.3], [-0.3, -0.3]]) { const c = new V(f.x + ox, f.y - 0.5, f.z + oz).floored(); cells.set(c.toString(), c) }
      const solid = [...cells.values()].filter(c => { const b = bot.blockAt(c); return b && b.boundingBox === 'block' && b.name !== 'bedrock' && b.diggable !== false })
      if (!solid.length) return { ok: dug > 0, dug, why: dug ? 'опоры нет' : 'под ним пусто' }
      const seen = solid.filter(c => pk.blockSeen(bot, c, { range: 4.5 }))
      if (!seen.length) return { ok: dug > 0, dug, why: 'опору не видно или не достать' }
      for (const c of seen) {
        if (ctl.aborted) break
        const b = bot.blockAt(c); if (!b || b.boundingBox !== 'block') continue
        try { await bot.lookAt(c.offset(0.5, 0.5, 0.5), true); await bot.dig(b, true); dug++ } catch {}
      }
    }
    return { ok: dug > 0, dug }
  }, { timeoutMs: 12000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
  // Выстрел из-за стенки в прыжке (13.10, арена: «ставит блоки, прыгает и выстреливает из лука — очень крутой приём»):
  // стенка в 2 бл. в клетке к нему (честно, build.placeBlockAt; блоков нет — без неё), лук натянут за ней до полной силы
  // (bow.shoot holdWhile), прыжок, на вершине (глаза над стенкой, vy ≤ 0.08) — спуск с упреждением и поправкой на своё
  // движение (bow.shoot compensate); закрыто в миг спуска — не стреляет. Повтор shots раз, пока он в 6–40 бл.
  peek_shot: async (p: any = {}) => session.runIntent('peek_shot', async (ctl) => {
    const bot = session.require()
    const V = require('vec3'); const bow = require('./bow'); const { placeBlockAt, pickFiller } = require('./build')
    const foe = bot.players[String(p.target || '')]?.entity
    if (!foe) return { ok: false, why: 'не вижу его' }
    if (!bot.inventory.items().some(i => i.name === 'bow') || !bot.inventory.items().some(i => /arrow$/.test(i.name))) return { ok: false, why: 'нет лука или стрел' }
    bot.pathfinder?.setGoal(null)
    const me = bot.entity.position; const ff = me.floored()
    const dx = foe.position.x - me.x; const dz = foe.position.z - me.z
    const step = Math.abs(dx) >= Math.abs(dz) ? new V(Math.sign(dx), 0, 0) : new V(0, 0, Math.sign(dz))
    let wall = 0
    if (pickFiller(bot)) for (const h of [0, 1]) {
      if (ctl.aborted) break
      const c = ff.plus(step).offset(0, h, 0); const b = bot.blockAt(c)
      if (b && b.boundingBox === 'block') { wall++; continue }
      const r = await placeBlockAt(bot, c, { honest: true, timeoutMs: 1000, ctl }).catch(() => null)
      if (r?.ok) wall++
    }
    const shots = Math.max(1, Math.min(6, p.shots ?? 3))
    let fired = 0; let hits = 0; let why = null
    for (let k = 0; k < shots && !ctl.aborted; k++) {
      const d = bot.entity.position.distanceTo(foe.position)
      if (d < 6 || d > 40 || !bot.players[String(p.target)]?.entity) { why = d < 6 ? 'он близко' : 'ушёл'; break }
      let jumpAt = -1
      const r = await bow.shoot(bot, foe, {
        peek: true, follow: false, holdMaxMs: 1500,
        // Тетива натянута — прыжок; держать до вершины (глаза над стенкой) или 14 тиков.
        holdWhile: () => {
          const t = gameClock.now()
          if (jumpAt < 0) { jumpAt = t; bot.setControlState('jump', true); return true }
          if (t - jumpAt > 100) bot.setControlState('jump', false)
          if (t - jumpAt > 700) return false
          return bot.entity.onGround || bot.entity.velocity.y > 0.08
        },
        onHit: () => { hits++ }
      }).catch(e => ({ shot: false, why: e.message }))
      bot.setControlState('jump', false)
      if (r?.shot) fired++; else if (!why) why = r?.why || null
      for (let t = 0; t < 20 && !bot.entity.onGround && !ctl.aborted; t++) await bot.waitForTicks(1)
    }
    return { ok: fired > 0, fired, hits, wall, why }
  }, { timeoutMs: 20000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
  // Спасение при падении в пропасть (13.10, арена: «ботов сбивают в обрыв — ничего не успевают сделать»): падаю
  // (v.y < −0.5), а пола выше смертельной высоты killY подо мной в 80 бл. нет — элитры (из рюкзака на тело в воздухе) и
  // ракеты есть: раскрыть и лететь к safe (fly_to: над гребнем, посадка с открытым небом). Конфиг — от драйвера арены.
  rescue_config: async (p: any = {}) => {
    session._rescue = p.off ? null : { safe: p.safe, killY: Number(p.killY) }
    const bot = session.bot
    if (bot && !bot._ndRescue) {
      bot._ndRescue = true
      let busyRescue = false
      bot.on('physicsTick', () => {
        const cfg = session._rescue; const b = bot.entity
        if (!cfg || busyRescue || !b || b.onGround || b.isInWater || b.elytraFlying || b.velocity.y > -0.5 || (bot.health ?? 0) <= 0) return
        const sky = require('./elytra')
        const f = sky.worldOf(bot).floorBelow(b.position.x, b.position.y, b.position.z, 80)
        // Внизу смертельная высота, лава — или само падение больше хп (+3): раскрыть. Раньше — только «внизу пусто»: бот
        // летел вдоль гребня, под ним мелькали уступы, и спасение включалось уже в зоне смерти (y 112 при killY 113).
        const fall = f ? b.position.y - f.top : Infinity
        if (f && f.top >= cfg.killY + 1 && !f.lava && fall <= (bot.health ?? 20) + 3) return
        const k = sky.kit(bot)
        if (!k.elytra || k.rockets < 1) return
        busyRescue = true
        console.log('[rescue] падаю в пропасть — элитры', JSON.stringify({ y: Math.round(b.position.y), floor: f ? f.top : null, killY: cfg.killY }))
        methods.fly_to({ at: cfg.safe, timeoutSeconds: 15, rescue: true }).then(r => console.log('[rescue]', JSON.stringify(r?.detail || r).slice(0, 200))).catch(() => {}).finally(() => { busyRescue = false })
      })
    }
    return { status: 'done', detail: { on: !!session._rescue } }
  },
  // Сдуть с края (13.10, арена: человек так сбрасывает ботов с Колизея — «ветром не могут в меня попасть»): он у обрыва
  // (за ним по линии от меня падение 5+ бл. или пусто в 1–2 бл.) — заряд ветра в пол у его ног с моей стороны с
  // упреждением (заряд 1.5 б/т без гравитации): всплеск толкает «центр → глаза» — от меня, за край. Честно: точка видна.
  wind_push: async (p: any = {}) => session.runIntent('wind_push', async ctl => {
    const bot = session.require(), sight = require('./pvp/last-seen').createLastSeen(bot)
    try {
      const e = sight.observe(bot.players?.[p.target]?.entity)
      if (!e || !sight.visible(e)) return { ok: false, fired: false, why: 'цель не видна' }
      const mace = require('./mace')
      if (!p.force && !mace.pushPlan(bot, e, { sees: true, theyUp: e.position.y > bot.entity.position.y + 2 })) return { ok: false, fired: false, why: 'толкать сейчас невыгодно' }
      const result = await mace.windPush(bot, e, { vel: () => sight.observe(e)?.velocity || { x: 0, y: 0, z: 0 } })
      return { ...result, ok: !!result.fired }
    } finally { sight.close() }
  }, { timeoutMs: 3000, interruptOn: ['death', 'kicked', 'disconnected'], params: p }),
  watch_dangers: async (p: any = {}) => { dangerWatch = p.on === false ? null : { foes: Array.isArray(p.foes) ? p.foes.map(String) : [] }; return { status: 'done', detail: { on: !!dangerWatch } } },
  connect: async (p) => {
    const r = await session.connect(p || {})
    // Same envelope as every other method so the brain reads one shape.
    return { status: 'done', detail: r.already ? { already: true } : { joined: true }, events: bus.drain(), state: session.state() }
  },
  disconnect: async (p) => { await vision.close(); return session.disconnect(p && p.reason) },

  say: async (p) => session.say(p.text, p.to),
  goto: async (p) => session.goto(p),
  flight_route: async (p) => session.flightRoute(p || {}),
  boat_hop: async (p) => session.boatHop(p || {}),
  boat_climb: async (p) => session.boatClimb(p || {}),
  parkour: async (p) => session.parkour(p || {}),
  follow: async (p) => session.follow(p),
  escort: async (p) => session.escort(p || {}),
  give: async (p) => session.giveItem(p || {}),
  take: async (p) => session.takeItem(p || {}),
  // Спасение на элитрах (rescue) стоп драйвера не рвёт: тревога «человек рядом» глушила полёт из пропасти.
  stop: async () => (session.current?.name === 'fly_to' && session.current?.params?.rescue && !session.current.ctl?.aborted) ? { status: 'done', detail: { ignored: 'спасаюсь на элитрах' } } : session.stop(),
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
  furnace_take: async (p) => session.furnaceTake(p || {}),
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
      // Заряд — только в опору (13.10: «себе под ноги — только когда есть опора, а так пулял в никуда»): луч взгляда до
      // первого твёрдого блока в 3.5 бл., точка удара не дальше 2.3 от ног (всплеск достаёт до 2.4); за спиной пусто —
      // строго вниз; и там нет — не бросать.
      const burstAt = (yw, pt) => {
        const e = bot.entity.position.offset(0, 1.62, 0); const d = { x: -Math.sin(yw) * Math.cos(pt), y: Math.sin(pt), z: -Math.cos(yw) * Math.cos(pt) }
        for (let s = 0.2; s <= 3.5; s += 0.1) {
          const q = e.offset(d.x * s, d.y * s, d.z * s); const b = bot.blockAt(q.floored())
          if (b && b.boundingBox === 'block') return q.distanceTo(bot.entity.position) <= 2.3 ? q : null
        }
        return null
      }
      let ly = flat ? yaw + Math.PI : yaw; let lp = flat ? -1.25 : -Math.PI / 2
      if (!burstAt(ly, lp)) { ly = yaw; lp = -Math.PI / 2 }
      if (!burstAt(ly, lp)) { bot.setControlState('sprint', false); bot.setControlState('forward', false); return { used, rise: 0, why: 'нет опоры для заряда' } }
      await bot.look(ly, lp, true)
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
    if (p.observed === true) return require('./swarm-position').pearlToPosition(session, ctl, { to: p.to, arena: p.arena })
    const ph = require('./pearl-hop')
    const from = bot.entity.position.clone()
    const r = await ph.hopTo(bot, p.to, { reserve: 0, minGain: -999, hpMin: 3, maxHops: p.maxHops ?? 1, arriveR: 3, walkSec: 999, edgeOk: !!p.edgeOk, yTop: p.yTop ?? 30, abortIf: () => ctl.aborted })
    const me = bot.entity.position
    // loose — «куда-нибудь прочь»: удача, если перенёсся на 6+ бл.
    const ok = Math.hypot(me.x - p.to.x, me.y - p.to.y, me.z - p.to.z) <= 4 || (!!p.loose && me.distanceTo(from) >= 6)
    return { ok, hops: r.hops, stop: r.stop, why: r.why, at: { x: Math.round(me.x), y: Math.round(me.y), z: Math.round(me.z) } }
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

// Наблюдение опасностей для драйвера арены (watch_dangers): враги-люди — их прицел, падение с булавой.
let dangerWatch: { foes: string[] } | null = null
const wss = new WebSocketServer({ host: cfg.wsHost, port: cfg.wsPort })

let clients = 0
wss.on('connection', (ws) => {
  clients++
  session.brainAttached = clients > 0
  const sendClock = (clock = gameClock.snapshot()) => {
    if (clock && ws.readyState === 1 && (ws.bufferedAmount || 0) < 65536) ws.send(JSON.stringify({ type: 'clock', clock }))
  }
  // Опасности — каждый игровой тик (на ускоренном сервере стенные 50 мс — несколько тиков опоздания уворота).
  const pushDanger = () => {
    if (!dangerWatch || ws.readyState !== 1 || !session.bot?.entity) return
    try {
      const d = require('./threats').dangers(session.bot, { foes: dangerWatch.foes })
      if (d.potions.length || d.clouds.length || d.smashes.length || d.arrows.length || d.aims.length || d.lava.length) ws.send(JSON.stringify({ type: 'danger', dangers: { potions: d.potions, clouds: d.clouds, smashes: d.smashes, arrows: d.arrows, aims: d.aims, lava: d.lava }, pos: session.bot.entity.position }))
    } catch {}
  }
  let sourceClock
  let lastPublished = 0
  // Followers have no independent prediction loop. Publish every five game
  // ticks so short game sleeps don't wait 250 wall ms at an accelerated rate.
  const onTick = ticks => {
    try { pushDanger() } catch {}
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
