'use strict'
// Бой с драконом (dragonFight, dragon/dragon.ts) — состояние вызова и его рамка: отчёт, осмотр (mode look), ожидание
// прогрузки Края, проверка снаряжения, сторожа на время боя и их снятие. Прежние let и стрелки замыкания dragonFight —
// поля объекта df (DragonFight). Путь к центру и бой — dragon/route.ts, оркестр — dragon/dragon.ts.
import { gameClock, dragonOf, hpOf, PHASE_RU, phaseOf, CENTER, voidBelow, DEBUG, dbg, clearControls } from '../dig-down-to'
import { kitOf, clearCrystalKnowledge, missing, crystalKitState, hitTracker, fireballTracker, makeTrace } from '../bridge-to-island'
import { crystalsOf, lookGuard, fallGuard, cloudReflex, fireballAlarm } from '../fall-guard'
import { crysAlive } from '../station-plan'
import { portalBlocks } from '../pillar-plan'

export interface DragonFight {
  session: any
  ctl: any
  p: any
  bot: any
  mode: string
  started: number
  deadline: number
  hp0: number
  rep: any
  stats: any
  kit: any
  died: boolean
  onDeath: () => void
  report: (stopped?: any) => any
  lookSpeed: any[] | null
  unguard: () => void
  unfall: () => void
  uncloud: () => void
  unhit: () => void
  unfb: () => void
  unalarm: () => void
  trace: any
  onRespawn: () => void
  taps: (() => void)[]
  onAbort: () => void
  pearlOn: boolean
  pearlStep: (where: any) => Promise<any>
}

// Начало вызова: отчёт и счётчики боя (прежнее начало dragonFight).
export function dfOpen (session, ctl, p: any = {}): DragonFight {
  const bot = session.bot
  const df = { session, ctl, p, bot } as DragonFight
  df.mode = p.mode || 'beds'
  df.started = gameClock.now()
  df.deadline = df.started + Math.min(600, p.timeoutSeconds ?? 300) * 1000 - 5000
  df.hp0 = Math.round(bot.health)
  df.rep = {
    mode: df.mode,
    crystals: { seen: 0, destroyed: 0, left: null, notes: [] },
    dragon: {},
    // Секунды от начала вызова: кристаллы сбиты, дракон убит.
    timing: {}
  }
  df.stats = { arrows: 0, crystals: 0, melee: 0, dmg: 0, arrowHits: 0, headShots: 0, perches: [], phases: [], dodges: {}, endermen: 0, ate: [], hid: [], noSpot: 0, guarded: 0, beds: [] }
  df.kit = kitOf(bot)
  df.rep.kit = df.kit
  // «20 -> 20» после смерти — ложь разности (грабли прогонов): после
  // возрождения снова двадцать. Смерть — отдельным свидетелем.
  df.died = false
  df.onDeath = () => { df.died = true; clearCrystalKnowledge(bot) }
  df.report = (stopped?: any) => {
    const d = dragonOf(bot)
    df.rep.hp = df.died ? `${df.hp0} -> УМЕР` : `${df.hp0} -> ${Math.round(bot.health)}`
    if (df.died) df.rep.died = true
    df.rep.seconds = Math.round((gameClock.now() - df.started) / 1000)
    // Счёт — только из Энда: после смерти тело в верхнем мире и «видит» ноль.
    if (/end/.test(bot.game.dimension)) df.rep.crystals.left = crystalsOf(bot).filter(c => c.pillar).length
    df.rep.crystals.destroyed = df.stats.crystals
    df.rep.crystals.arrows = df.stats.arrows
    // кристаллы с места ожидания (crystalWait, 03.10): стрел, сбито своими, переходов к точке выстрела, живых по памяти боя
    if (ctl.crys && ctl.crys.known.size) df.rep.crystals.wait = { shots: ctl.crys.shots, hits: ctl.crys.hits, moves: ctl.crys.moves, alive: crysAlive(ctl), known: ctl.crys.known.size, first: ctl.crys.firstShot ? Math.round((ctl.crys.firstShot - df.started) / 1000) : null }
    if (d) { df.rep.dragon.hp = Math.round(hpOf(bot, d) ?? 0); df.rep.dragon.phase = PHASE_RU[phaseOf(bot, d)] ?? null }
    df.rep.dragon.melee = { swings: df.stats.melee, perches: df.stats.perches.filter(x => x.reached).length, byPerch: df.stats.perches.filter(x => x.reached).slice(-6).map(({ dbgAt, ...x }: any) => ({ ...x, dmg: Math.round(x.dmg) })) }
    df.rep.dragon.arrows = { shot: df.stats.arrows, hits: df.stats.arrowHits, atHead: df.stats.headShots }
    if (df.stats.stationNone && !df.stats.stations) df.rep.dragon.stationNone = df.stats.stationNone
    if (df.stats.beds.length || df.stats.bedNoPlan) df.rep.dragon.beds = { used: df.stats.bedsUsed || 0, blasts: df.stats.beds.slice(-6), noPlan: df.stats.bedNoPlan }
    df.rep.dragon.dmgSeen = Math.round(df.stats.dmg)
    df.rep.dragon.phases = df.stats.phases.slice(-20)
    df.rep.dodged = df.stats.dodges
    df.rep.endermen = { fought: df.stats.endermen, killed: df.stats.endermenKilled || 0, lookGuard: df.stats.guarded, stareCut: df.stats.stareCut || 0 }
    if (df.stats.ate.length) df.rep.ate = df.stats.ate
    if (df.stats.hid.length) df.rep.hid = df.stats.hid
    if (df.stats.potions && df.stats.potions.length) df.rep.potions = df.stats.potions
    if (df.stats.clutch && Object.keys(df.stats.clutch).length) df.rep.clutch = df.stats.clutch
    if (stopped) df.rep.stopped = stopped
    // Станция у столба построена в этом вызове — секунды от его начала (сцена складывает по вызовам).
    if (ctl.pillar && ctl.pillar.built && ctl.pillar.t >= df.started) df.rep.timing.station = Math.round((ctl.pillar.t - df.started) / 100) / 10
    if (df.rep.leftEnd && !df.rep.stopped) df.rep.stopped = `тело ушло из Энда само (${df.rep.leftEnd}) — бой прерван`
    if (!df.rep.crystals.notes.length) delete df.rep.crystals.notes
    return df.rep
  }
  return df
}

// mode look: что видно с места — дракон, кристаллы, срез блоков вокруг.
export function dfLook (df: DragonFight) {
  const { bot, p } = df
  const d = dragonOf(bot)
  df.rep.dragon = d ? { hp: Math.round(hpOf(bot, d) ?? 0), phase: PHASE_RU[phaseOf(bot, d)], at: { x: Math.round(d.position.x), y: Math.round(d.position.y), z: Math.round(d.position.z) } } : { seen: false }
  df.rep.crystals = { seen: crystalsOf(bot).filter(c => c.pillar).map(c => ({ x: c.cx, y: c.top + 1, z: c.cz, caged: c.bars > 0, dist: Math.round(c.pos.distanceTo(bot.entity.position)) })) }
  const me = bot.entity.position
  df.rep.fromCenter = Math.round(Math.hypot(me.x - CENTER.x, me.z - CENTER.z))
  df.rep.portal = portalBlocks(bot).length > 0
  df.rep.note = 'кристаллы видно только с 64 блоков — список полный лишь у центра острова'
  if (p.around) {
    // Для разбора: срез блоков вокруг (сцены), по слою на высоту.
    const c = me.floored()
    df.rep.pos = { x: +me.x.toFixed(2), y: +me.y.toFixed(2), z: +me.z.toFixed(2), onGround: bot.entity.onGround, vehicle: bot.vehicle ? (bot.vehicle.name || bot.vehicle.id) : null, physics: bot.physicsEnabled }
    df.rep.around = {}
    for (let dy = -2; dy <= 2; dy++) {
      const rows = []
      for (let dz = -3; dz <= 3; dz++) {
        let row = ''
        for (let dx = -3; dx <= 3; dx++) {
          const b = bot.blockAt(c.offset(dx, dy, dz))
          row += !b ? '?' : b.name === 'air' ? '.' : b.name === 'end_stone' ? 'e' : b.name === 'cobblestone' ? 'c' : b.name === 'obsidian' ? 'o' : b.name[0].toUpperCase()
        }
        rows.push(row)
      }
      df.rep.around[`y${c.y + dy}`] = rows.join('|')
    }
  }
  return df.rep
}

export async function dfArrive (df: DragonFight) {
  const { bot, ctl, session } = df
  // respawn names the End before its column arrives; null support skipped the bridge.
  const arrivalLoaded = () => {
    const f = bot.entity.position.floored()
    return [-1, 0, 1].every(dy => bot.blockAt(f.offset(0, dy, 0)))
  }
  let loading = false
  while (!arrivalLoaded()) {
    if (ctl.aborted) return df.report('прервано при входе в Край')
    if (session.bot !== bot || bot.isAlive === false || !(bot.health > 0) || !/end/.test(bot.game.dimension)) return df.report('тело сменилось при входе в Край')
    if (gameClock.now() >= df.deadline) return df.report('мир под ногами ещё не прогружен')
    try { bot.pathfinder.setGoal(null) } catch {}
    clearControls(bot)
    loading = true
    await gameClock.wall.sleep(50)
  }
  if (loading && ctl.aborted) return df.report('прервано при входе в Край')
  if (loading && (session.bot !== bot || bot.isAlive === false || !(bot.health > 0) || !/end/.test(bot.game.dimension))) return df.report('тело сменилось при входе в Край')
}

// Снаряжение: чего не хватает — отказ до первого шага (итог — rep, иначе undefined).
export function dfKit (df: DragonFight) {
  const { bot } = df
  const me0 = bot.entity.position
  let at = null
  if (Math.hypot(me0.x - CENTER.x, me0.z - CENTER.z) < 40) {
    const cr = crystalsOf(bot).filter(c => c.pillar)
    at = { crystals: cr.length, caged: cr.filter(c => c.bars > 0).length }
  }
  // На острове (под ногами не пустота) блоки добываются киркой — повторный
  const onIsland = !voidBelow(bot, me0.x, me0.y, me0.z, 60)
  const need = missing(df.kit, df.mode, crystalKitState(bot, at, onIsland))
  if (need.length) {
    df.rep.need = need[0]
    df.rep.needAll = need
    df.rep.stopped = `не хватает снаряжения: ${need.map(n => `${n.what} ${n.have}/${n.count}`).join(', ')} — ни шагу не сделал`
    return df.rep
  }
}

// Сторожа и подписки на время боя (прежнее начало перед try): ctl, взгляд, падение, облака, трасса.
export function dfArm (df: DragonFight) {
  const { bot, ctl, p } = df
  ctl.deadline = df.deadline
  ctl.started = df.started
  ctl.stats = df.stats
  // Кровати у головы — по умолчанию, если они в рюкзаке; beds:false — только меч.
  ctl.beds = p.beds !== false || df.mode === 'beds'
  ctl.bedsOnly = df.mode === 'beds'
  ctl.noRise = p.rise === false
  bot.on('death', df.onDeath)
  // Полуширина хитбокса как у сервера (0.6f / 2), а не 0.3: иначе тело,
  if (bot.physics) bot.physics.playerHalfWidth = Math.fround(0.6) / 2
  // Взгляд уходит серверу сразу, без доворота. mineflayer шлёт не
  df.lookSpeed = bot.physics ? [bot.physics.yawSpeed, bot.physics.pitchSpeed] : null
  if (bot.physics) { bot.physics.yawSpeed = 1000; bot.physics.pitchSpeed = 1000 }
  df.unguard = lookGuard(bot, df.stats)
  df.unfall = fallGuard(bot, df.stats, ctl)
  df.uncloud = cloudReflex(bot, ctl, df.stats)
  df.unhit = hitTracker(bot)
  df.unfb = fireballTracker(bot)
  df.unalarm = fireballAlarm(bot, ctl, df.stats)
  df.trace = makeTrace(bot, ctl, df.stats)
  ctl.trace = df.trace
  // Кто оборвал вызов (camp1: бой кончился «done» без причины на 175 с —
  // кто-то снял намерение). Стек — в трассу.
  ctl.onAbort.push(() => df.trace.ev('aborted', { by: String(new Error().stack).split('\n').slice(2, 8).map(s => s.trim().replace(/^at /, '').replace(/\(.*[\\/]/, '(')).join(' < ') }))
  if (df.trace.file) df.rep.trace = df.trace.file
  // Ушёл из Энда не домой (соскользнул в выходной портал, умер) — всё
  // остановить: бой, продолжающийся в верхнем мире, бьёт эндерменов ночью.
  df.onRespawn = () => {
    if (ctl.homeBound || /end/.test(bot.game.dimension)) return
    df.rep.leftEnd = bot.game.dimension
    try { ctl.abort() } catch {}
  }
  bot.on('respawn', df.onRespawn)
  df.taps = DEBUG ? ['mount', 'dismount', 'respawn', 'death', 'forcedMove'].map(ev => { const f = () => dbg('event', ev, bot.entity.position.toString()); bot.on(ev, f); return () => bot.removeListener(ev, f) }) : []
  if (DEBUG) {
    // Что мы слали серверу перед тем, как он вернул нас назад (отбой шага).
    const sent = []
    const origWrite = bot._client.write
    bot._client.write = function (name, params) {
      if (/^position/.test(name) || name === 'flying') {
        sent.push(`${name} ${params.x !== undefined ? `${params.x.toFixed(4)},${params.y.toFixed(4)},${params.z.toFixed(4)}` : ''} g${params.onGround ?? (params.flags && params.flags.onGround)}`)
        if (sent.length > 4) sent.shift()
      }
      return origWrite.apply(this, arguments)
    }
    df.taps.push(() => { bot._client.write = origWrite })
    let lastLog = 0
    const f = pk => {
      if (gameClock.now() - lastLog < 3000) return
      lastLog = gameClock.now()
      dbg('server pos', pk.x.toFixed(4), pk.y.toFixed(4), pk.z.toFixed(4), 'tp', pk.teleportId, 'sent:', sent.join(' | '))
    }
    bot._client.on('position', f)
    df.taps.push(() => bot._client.removeListener('position', f))
  }
  df.onAbort = () => clearControls(bot)
  ctl.onAbort.push(df.onAbort)
}

// Сорвалось (прежний catch): ошибка и где — в отчёт.
export function dfError (df: DragonFight, e) {
  df.rep.error = String((e && e.message) || e)
  // Где сорвалось — первые строки стека (без них «reading 'id'» не найти).
  if (e && e.stack) {
    df.rep.errorAt = String(e.stack).split('\n').slice(1, 5).map(l => l.trim().replace(/^at /, '').replace(/\(.*[\\/]/, '(')).join(' ← ')
    console.error('[dragon] сорвалось:', e.stack)
  }
  return df.report(`сорвалось: ${df.rep.error}`)
}

// Снять сторожей и подписки (прежний finally).
export function dfClose (df: DragonFight) {
  const { bot, ctl, session } = df
  if (ctl.feed) { ctl.feed.close(); ctl.feed = null }
  bot.removeListener('death', df.onDeath)
  for (const t of df.taps) t()
  df.unguard()
  df.unfall()
  df.uncloud()
  df.unhit()
  df.unfb()
  df.unalarm()
  if (bot.physics && df.lookSpeed) { bot.physics.yawSpeed = df.lookSpeed[0]; bot.physics.pitchSpeed = df.lookSpeed[1] }
  df.trace.close({ died: df.died, won: !!(df.rep.dragon && df.rep.dragon.won), stopped: df.rep.stopped || null })
  bot.removeListener('respawn', df.onRespawn)
  clearControls(bot)
  // Стоять, опустив голову: между вызовами сторожа взгляда нет, а
  // эндермен, попавший в прицел праздного взгляда, злится сам.
  if (bot.entity) bot.look(bot.entity.yaw, -1.3, true).catch(() => {})
  try { session.updateMovements(true) } catch {}
}
