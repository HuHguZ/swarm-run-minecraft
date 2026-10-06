const { gameClock, dragonOf, hpOf, PHASE_RU, phaseOf, CENTER, voidBelow, DEBUG, dbg, clearControls, armor, findItem, supportCell, offIsland, cloudsOf, isSolid, Vec3, pearlHop, starer, envv, digUpThrough, envNum, padOverVoid, runnerOn, sleep } = require('./dig-down-to')
const { kitOf, clearCrystalKnowledge, missing, crystalKitState, hitTracker, fireballTracker, makeTrace, bridgeToIsland, burrowTo, noteCrystalClear } = require('./bridge-to-island')
const { crystalsOf, lookGuard, fallGuard, cloudReflex, fireballAlarm, r1, inClouds, doing, pickSpot } = require('./fall-guard')
const { crysAlive, waterToHotbar } = require('./station-plan')
const { portalBlocks } = require('./pillar-plan')
const { dragonLab, respawnDragon, takeEgg, goHome, pearlApproach, blindPit, collectXp } = require('./blind-pit')
const { evade, countOf } = require('./evade-raw')
const { walkTo, destroyCrystals, makeDragonFeed, fightDragon } = require('./pillar-run')
async function dragon (session, ctl, p: any = {}) {
  const bot = session.bot
  const mode = p.mode || 'beds'
  const started = gameClock.now()
  const deadline = started + Math.min(600, p.timeoutSeconds ?? 300) * 1000 - 5000
  const hp0 = Math.round(bot.health)
  const rep: any = {
    mode,
    crystals: { seen: 0, destroyed: 0, left: null, notes: [] },
    dragon: {},
    // Секунды от начала вызова: кристаллы сбиты, дракон убит.
    timing: {}
  }
  const stats: any = { arrows: 0, crystals: 0, melee: 0, dmg: 0, arrowHits: 0, headShots: 0, perches: [], phases: [], dodges: {}, endermen: 0, ate: [], hid: [], noSpot: 0, guarded: 0, beds: [] }
  const kit = kitOf(bot)
  rep.kit = kit
  // «20 -> 20» после смерти — ложь разности (грабли прогонов): после
  // возрождения снова двадцать. Смерть — отдельным свидетелем.
  let died = false
  const onDeath = () => { died = true; clearCrystalKnowledge(bot) }
  const report = (stopped?: any) => {
    const d = dragonOf(bot)
    rep.hp = died ? `${hp0} -> УМЕР` : `${hp0} -> ${Math.round(bot.health)}`
    if (died) rep.died = true
    rep.seconds = Math.round((gameClock.now() - started) / 1000)
    // Счёт — только из Энда: после смерти тело в верхнем мире и «видит» ноль.
    if (/end/.test(bot.game.dimension)) rep.crystals.left = crystalsOf(bot).filter(c => c.pillar).length
    rep.crystals.destroyed = stats.crystals
    rep.crystals.arrows = stats.arrows
    // кристаллы с места ожидания (crystalWait, 03.10): стрел, сбито своими, переходов к точке выстрела, живых по памяти боя
    if (ctl.crys && ctl.crys.known.size) rep.crystals.wait = { shots: ctl.crys.shots, hits: ctl.crys.hits, moves: ctl.crys.moves, alive: crysAlive(ctl), known: ctl.crys.known.size, first: ctl.crys.firstShot ? Math.round((ctl.crys.firstShot - started) / 1000) : null }
    if (d) { rep.dragon.hp = Math.round(hpOf(bot, d) ?? 0); rep.dragon.phase = PHASE_RU[phaseOf(bot, d)] ?? null }
    rep.dragon.melee = { swings: stats.melee, perches: stats.perches.filter(x => x.reached).length, byPerch: stats.perches.filter(x => x.reached).slice(-6).map(({ dbgAt, ...x }: any) => ({ ...x, dmg: Math.round(x.dmg) })) }
    rep.dragon.arrows = { shot: stats.arrows, hits: stats.arrowHits, atHead: stats.headShots }
    if (stats.stationNone && !stats.stations) rep.dragon.stationNone = stats.stationNone
    if (stats.beds.length || stats.bedNoPlan) rep.dragon.beds = { used: stats.bedsUsed || 0, blasts: stats.beds.slice(-6), noPlan: stats.bedNoPlan }
    rep.dragon.dmgSeen = Math.round(stats.dmg)
    rep.dragon.phases = stats.phases.slice(-20)
    rep.dodged = stats.dodges
    rep.endermen = { fought: stats.endermen, killed: stats.endermenKilled || 0, lookGuard: stats.guarded }
    if (stats.ate.length) rep.ate = stats.ate
    if (stats.hid.length) rep.hid = stats.hid
    if (stats.potions && stats.potions.length) rep.potions = stats.potions
    if (stats.clutch && Object.keys(stats.clutch).length) rep.clutch = stats.clutch
    if (stopped) rep.stopped = stopped
    // Станция у столба построена в этом вызове — секунды от его начала (сцена складывает по вызовам).
    if (ctl.pillar && ctl.pillar.built && ctl.pillar.t >= started) rep.timing.station = Math.round((ctl.pillar.t - started) / 100) / 10
    if (rep.leftEnd && !rep.stopped) rep.stopped = `тело ушло из Энда само (${rep.leftEnd}) — бой прерван`
    if (!rep.crystals.notes.length) delete rep.crystals.notes
    return rep
  }
  if (!/end/.test(bot.game.dimension)) throw new Error(`я не в Энде (${bot.game.dimension}): бой с драконом — в Энде, сначала портал`)

  if (mode === 'look') {
    const d = dragonOf(bot)
    rep.dragon = d ? { hp: Math.round(hpOf(bot, d) ?? 0), phase: PHASE_RU[phaseOf(bot, d)], at: { x: Math.round(d.position.x), y: Math.round(d.position.y), z: Math.round(d.position.z) } } : { seen: false }
    rep.crystals = { seen: crystalsOf(bot).filter(c => c.pillar).map(c => ({ x: c.cx, y: c.top + 1, z: c.cz, caged: c.bars > 0, dist: Math.round(c.pos.distanceTo(bot.entity.position)) })) }
    const me = bot.entity.position
    rep.fromCenter = Math.round(Math.hypot(me.x - CENTER.x, me.z - CENTER.z))
    rep.portal = portalBlocks(bot).length > 0
    rep.note = 'кристаллы видно только с 64 блоков — список полный лишь у центра острова'
    if (p.around) {
      // Для разбора: срез блоков вокруг (сцены), по слою на высоту.
      const c = me.floored()
      rep.pos = { x: +me.x.toFixed(2), y: +me.y.toFixed(2), z: +me.z.toFixed(2), onGround: bot.entity.onGround, vehicle: bot.vehicle ? (bot.vehicle.name || bot.vehicle.id) : null, physics: bot.physicsEnabled }
      rep.around = {}
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
        rep.around[`y${c.y + dy}`] = rows.join('|')
      }
    }
    return rep
  }

  const me0 = bot.entity.position
  let at = null
  if (Math.hypot(me0.x - CENTER.x, me0.z - CENTER.z) < 40) {
    const cr = crystalsOf(bot).filter(c => c.pillar)
    at = { crystals: cr.length, caged: cr.filter(c => c.bars > 0).length }
  }
  // На острове (под ногами не пустота) блоки добываются киркой — повторный
  const onIsland = !voidBelow(bot, me0.x, me0.y, me0.z, 60)
  const need = missing(kit, mode, crystalKitState(bot, at, onIsland))
  if (need.length) {
    rep.need = need[0]
    rep.needAll = need
    rep.stopped = `не хватает снаряжения: ${need.map(n => `${n.what} ${n.have}/${n.count}`).join(', ')} — ни шагу не сделал`
    return rep
  }

  ctl.deadline = deadline
  ctl.started = started
  ctl.stats = stats
  // Кровати у головы — по умолчанию, если они в рюкзаке; beds:false — только меч.
  ctl.beds = p.beds !== false || mode === 'beds'
  ctl.bedsOnly = mode === 'beds'
  ctl.noRise = p.rise === false
  bot.on('death', onDeath)
  // Полуширина хитбокса как у сервера (0.6f / 2), а не 0.3: иначе тело,
  if (bot.physics) bot.physics.playerHalfWidth = Math.fround(0.6) / 2
  // Взгляд уходит серверу сразу, без доворота. mineflayer шлёт не
  const lookSpeed = bot.physics ? [bot.physics.yawSpeed, bot.physics.pitchSpeed] : null
  if (bot.physics) { bot.physics.yawSpeed = 1000; bot.physics.pitchSpeed = 1000 }
  const unguard = lookGuard(bot, stats)
  const unfall = fallGuard(bot, stats, ctl)
  const uncloud = cloudReflex(bot, ctl, stats)
  const unhit = hitTracker(bot)
  const unfb = fireballTracker(bot)
  const unalarm = fireballAlarm(bot, ctl, stats)
  const trace = makeTrace(bot, ctl, stats)
  ctl.trace = trace
  // Кто оборвал вызов (camp1: бой кончился «done» без причины на 175 с —
  // кто-то снял намерение). Стек — в трассу.
  ctl.onAbort.push(() => trace.ev('aborted', { by: String(new Error().stack).split('\n').slice(2, 8).map(s => s.trim().replace(/^at /, '').replace(/\(.*[\\/]/, '(')).join(' < ') }))
  if (trace.file) rep.trace = trace.file
  // Ушёл из Энда не домой (соскользнул в выходной портал, умер) — всё
  // остановить: бой, продолжающийся в верхнем мире, бьёт эндерменов ночью.
  const onRespawn = () => {
    if (ctl.homeBound || /end/.test(bot.game.dimension)) return
    rep.leftEnd = bot.game.dimension
    try { ctl.abort() } catch {}
  }
  bot.on('respawn', onRespawn)
  const taps = DEBUG ? ['mount', 'dismount', 'respawn', 'death', 'forcedMove'].map(ev => { const f = () => dbg('event', ev, bot.entity.position.toString()); bot.on(ev, f); return () => bot.removeListener(ev, f) }) : []
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
    taps.push(() => { bot._client.write = origWrite })
    let lastLog = 0
    const f = pk => {
      if (gameClock.now() - lastLog < 3000) return
      lastLog = gameClock.now()
      dbg('server pos', pk.x.toFixed(4), pk.y.toFixed(4), pk.z.toFixed(4), 'tp', pk.teleportId, 'sent:', sent.join(' | '))
    }
    bot._client.on('position', f)
    taps.push(() => bot._client.removeListener('position', f))
  }
  const onAbort = () => clearControls(bot)
  ctl.onAbort.push(onAbort)
  try {
    await armor.equipBestArmor(session, ctl).catch(() => {})
    // Вырезанная тыква на голове — эндермены не злятся на взгляд
    const pumpkin = findItem(bot, /^carved_pumpkin$/)
    const headNow = bot.inventory.slots[5]
    if (pumpkin && (p.pumpkin === true || (!headNow && p.pumpkin !== false))) {
      try { await bot.equip(pumpkin, 'head'); rep.pumpkin = true } catch (e) { rep.pumpkin = `не надел: ${e.message}` }
    }
    rep.waterReady = await waterToHotbar(bot)
    if (mode === 'labPlan' || mode === 'labRun') {
      rep.lab = await dragonLab(session, ctl, stats, p, mode, deadline)
      return report(rep.lab && rep.lab.stop ? rep.lab.stop : null)
    }
    if (mode === 'respawn') {
      clearCrystalKnowledge(bot)
      rep.respawn = await respawnDragon(session, ctl, rep)
      if (rep.respawn.need) rep.need = rep.respawn.need
      return report(rep.respawn.started ? null : `не воскресил: ${rep.respawn.why || 'поставил ' + rep.respawn.placed + ' из 4'}`)
    }
    if (mode === 'home') {
      if (p.egg !== false) rep.egg = await takeEgg(session, ctl, rep)
      rep.home = await goHome(session, ctl, rep)
      return report(rep.home.home ? null : `домой не ушёл: ${rep.home.why || rep.home.walk || 'портал не сработал'}`)
    }
    // Жемчуг (2026-10-01): с платформы — броском к станции у столба вместо моста и пешего пути, если
    // выходит быстрее с ценой хп (pearl-hop.js). ND_PEARL=0 или p.pearl === false — выкл.
    const pearlOn = (mode === 'beds' || mode === 'full' || mode === 'dragon') && p.pearl !== false && process.env.ND_PEARL !== '0'
    // Подход жемчугом и сводка по всем попыткам вызова (платформа, край острова после моста, на ходу к центру).
    const pearlStep = async (where) => {
      const ph = await pearlApproach(session, ctl, stats)
      if (!ph) return null
      const was = rep.pearl
      rep.pearl = was ? { ...ph, hops: was.hops + ph.hops, pearls: was.pearls + ph.pearls, hpLost: r1(was.hpLost + ph.hpLost), misses: was.misses + ph.misses, secs: r1(was.secs + ph.secs), steps: [...(was.steps || []), ...(ph.steps || [])], where: [...(was.where || []), where] } : { ...ph, where: [where] }
      if (ph.hops) rep.timing.pearl = Math.round((gameClock.now() - started) / 100) / 10
      return ph
    }
    if (pearlOn) await pearlStep('платформа')
    if (ctl.aborted) return report()
    // Прибыть: с платформы или издалека — мост к острову, потом к центру.
    const sup = supportCell(bot)
    if (sup && bot.blockAt(sup).name !== 'end_stone' && offIsland(bot, sup)) {
      const b: any = await bridgeToIsland(session, ctl, rep)
      // Платформа внутри острова (сид с сушей у x = 100: «потолок end_stone», «впереди не
      if (b.stopped && !b.land) {
        // Отказ повторят через пару секунд — не стоять при этом в облаке на платформе.
        const c0 = inClouds(cloudsOf(bot), bot.entity.position, 1)
        if (c0) await evade(bot, ctl, stats, { kind: 'облако', c: c0 }).catch(() => {})
        return report(`мост не дошёл до острова: ${b.stopped}`)
      }
    }
    if (ctl.aborted) return report()
    // Жемчуг с края острова (мост дошёл; с платформы броска не было — далеко/обрыв): к станции броском.
    if (pearlOn && !(rep.pearl && rep.pearl.hops)) await pearlStep('край')
    if (ctl.aborted) return report()
    // До центра: pathfinder, а не вышло — напролом (копать, мостить).
    const toCenter = async () => {
      const m = bot.entity.position
      if (Math.hypot(m.x - CENTER.x, m.z - CENTER.z) <= 25) return null
      const sup0 = supportCell(bot)
      if (sup0 && !offIsland(bot, sup0) && Math.hypot(m.x - CENTER.x, m.z - CENTER.z) < 45) return null
      // На ходу (раз в 2 с): бросок к станции стал выгоден — встать и бросить (s23/s24 pp1: платформа под обрывом,
      // с неё не бросить, а пешком к центру 60–70 с).
      let pearlAt = 0
      const pearlStop = pearlOn && (ctl.pearlWalkStops || 0) < 3 ? () => {
        if (gameClock.now() - pearlAt < 2000 || !bot.entity.onGround) return null
        pearlAt = gameClock.now()
        const mm = bot.entity.position
        if (Math.hypot(mm.x - CENTER.x, mm.z - CENTER.z) < 35) return null
        const under = bot.blockAt(mm.floored().offset(0, -1, 0))
        if (!under || under.name !== 'end_stone') return null
        // 03.10 (ca1-s10): в своём прокопе под островом бросок «на ходу» трижды бился о потолок («не перенесло», −3.4 хп
        // каждый) — бросать только под открытым небом (над головой на 12 блоков нет твёрдого)
        for (let k = 2; k <= 12; k++) { const b = bot.blockAt(mm.floored().offset(0, k, 0)); if (b && isSolid(b)) return null }
        const goal = ctl.pearlGoal || new Vec3(CENTER.x + (mm.x - CENTER.x) * 8 / Math.hypot(mm.x - CENTER.x, mm.z - CENTER.z), mm.y, CENTER.z + (mm.z - CENTER.z) * 8 / Math.hypot(mm.x - CENTER.x, mm.z - CENTER.z))
        const hw = pearlHop.hopWorth(bot, goal, { reserve: Number(process.env.ND_PEARL_RESERVE ?? 1), hpMin: Number(process.env.ND_PEARL_HPMIN ?? 11), floorOk: (b) => b.name === 'end_stone', avoid: (f) => Math.hypot(f.x - CENTER.x, f.z - CENTER.z) < 4.5, lookOk: (y, pt) => !starer(bot, y, pt) })
        return hw.go ? 'жемчуг' : null
      } : null
      // 03.10 (пользователь видел тоннель на слоте 1, rs17-s8 22:05: платформа внутри острова — walkTo 30 с, потом burrowTo
      if (envv('ND_DIGUP') !== '0' && envv('ND_DIGUP_FIRST') !== '0' && !ctl.digUpFirst) {
        const f0 = bot.entity.position.floored()
        let ceil = false
        for (let k = 2; k <= 7 && !ceil; k++) { const b = bot.blockAt(f0.offset(0, k, 0)); if (b && b.name === 'end_stone') ceil = true }
        if (ceil) {
          ctl.digUpFirst = true
          doing(ctl, 'to-center:dig-up')
          const t0u = gameClock.now()
          const up: any = await digUpThrough(session, ctl)
          up.ms = gameClock.now() - t0u; up.first = true
          if (ctl.trace) ctl.trace.ev('digUp', up)
          // бросок сразу с верха шахты дважды «не перенесло» (cp1-s7, ca1-s5: −5…6 с) — жемчуг только «на ходу», под открытым небом
          if (ctl.aborted) return { walk: 'прервано', up }
          doing(ctl, 'to-center')
          return toCenter()
        }
      }
      // над пустотой (свой мост, платформа) — без копки: pathfinder рыл нависший остров с моста в блок шириной, тело в воздухе
      const runC = envv('ND_CENTER_RUN') !== '0'
      const supW = supportCell(bot); const overVoid = !!(supW && offIsland(bot, supW))
      const w = await walkTo(session, ctl, new Vec3(CENTER.x, m.y, CENTER.z), { range: 18, xz: true, timeoutMs: 30000, stopIf: pearlStop, noDig: overVoid, sprint: runC, digCost: runC ? envNum('ND_CENTER_DIGCOST', 4) : 1 })
      if (w.stopped && w.why === 'жемчуг') {
        ctl.pearlWalkStops = (ctl.pearlWalkStops || 0) + 1
        clearControls(bot)
        await pearlStep('на ходу')
        doing(ctl, 'to-center')
        return toCenter()
      }
      if (w.ok) return { walk: 'дошёл' }
      // 02.10 (rs6-s18, смерть): мост с платформы под нависшим островом («потолок end_stone»), pathfinder рыл остров с моста над
      const supV = supportCell(bot)
      // 02.10 (rs10-s7, rs11-s7, сид пула 9123766181046481267): платформа под нависшим островом — мост упирается в «потолок
      if (supV && offIsland(bot, supV) && envv('ND_DIGUP') !== '0') {
        const up = await digUpThrough(session, ctl)
        if (ctl.trace) ctl.trace.ev('digUp', up)
        // шахта поднялась хоть на 3 (rs13-s7: 5 блоков вверх, дальше столб не встал — второй вызов пошёл оттуда пешком и дошёл) — идти
        if (up.ok || up.up >= 3) {
          const w3 = await walkTo(session, ctl, new Vec3(CENTER.x, bot.entity.position.y, CENTER.z), { range: 18, xz: true, timeoutMs: 45000, stopIf: pearlStop, sprint: runC, digCost: runC ? envNum('ND_CENTER_DIGCOST', 4) : 1 })
          if (w3.ok) return { walk: 'дошёл через остров над платформой', up }
          const sv3 = supportCell(bot)
          if (!(sv3 && offIsland(bot, sv3))) return { walk: w3.why, burrow: await burrowTo(session, ctl, new Vec3(CENTER.x, bot.entity.position.y, CENTER.z), { near: 18 }), up }
        }
      }
      if (supV && offIsland(bot, supV)) {
        const pad = await padOverVoid(bot, supV)
        if (ctl.trace) ctl.trace.ev('voidPad', pad)
        if (!pad.ok) { ctl.voidStop = true; return { walk: w.why, burrow: { ok: false, why: 'над пустотой — площадку не сложить' } } }
        const w2 = await walkTo(session, ctl, new Vec3(CENTER.x, m.y, CENTER.z), { range: 18, xz: true, timeoutMs: 45000, stopIf: pearlStop, sprint: runC, digCost: runC ? envNum('ND_CENTER_DIGCOST', 4) : 1 })
        if (w2.ok) return { walk: 'дошёл с площадки', pad }
        const sv2 = supportCell(bot)
        if (sv2 && offIsland(bot, sv2)) { ctl.voidStop = true; return { walk: w2.why, burrow: { ok: false, why: 'над пустотой — напролом нельзя' } } }
      }
      const b = await burrowTo(session, ctl, new Vec3(CENTER.x, m.y, CENTER.z), { near: 18 })
      return { walk: w.why, burrow: b }
    }
    if (mode === 'arrive') {
      rep.approach = await toCenter()
      const spot = pickSpot(bot, CENTER, { rMin: 8, rMax: 18 })
      if (spot) rep.walk = await walkTo(session, ctl, spot.feet, { range: 1.5, timeoutMs: 60000, stats })
      const m = bot.entity.position
      rep.fromCenter = Math.round(Math.hypot(m.x - CENTER.x, m.z - CENTER.z))
      return report(rep.fromCenter > 25 ? `до центра острова не дошёл: ${rep.walk ? rep.walk.why : 'нет места'}` : null)
    }
    doing(ctl, 'to-center')
    if (mode === 'full' || mode === 'crystals' || mode === 'dragon' || mode === 'beds') rep.approach = await toCenter()
    if (ctl.voidStop) { const sv = supportCell(bot); if (sv && offIsland(bot, sv)) return report('до центра острова не дошёл: над пустотой, напролом нельзя') }
    {
      const m = bot.entity.position
      if (Math.hypot(m.x - CENTER.x, m.z - CENTER.z) < 30) rep.timing.center = Math.round((gameClock.now() - started) / 100) / 10
    }
    if (mode === 'full' || mode === 'crystals') {
      await destroyCrystals(session, ctl, rep, stats, { deadline })
      noteCrystalClear(bot, rep.crystals)
      if (!ctl.aborted && /end/.test(bot.game.dimension) && rep.crystals.left === 0) rep.timing.crystals = Math.round((gameClock.now() - started) / 1000)
      if (ctl.aborted) return report()
      if (mode === 'crystals') return report(rep.crystals.left ? `кристаллов осталось ${rep.crystals.left}` : null)
    }
    if (mode === 'beds' && !ctl.feed) { ctl.feed = makeDragonFeed(bot) }
    // Станция у столба — по умолчанию, если в рюкзаке обсидиан (fightkit end: ≥ 4; станции нужно 2): ND_PILLAR=0 — выкл.,
    // ND_PILLAR=1 — вкл. и без него. С ней яма для слепого не нужна (pil4/pil5: ND_BEDS_BLIND=0).
    ctl.pillarMode = mode === 'beds' && (process.env.ND_PILLAR === '1' || (process.env.ND_PILLAR !== '0' && (runnerOn() || countOf(bot, /^(obsidian|crying_obsidian)$/) >= 2)))
    if (mode === 'beds' && process.env.ND_BEDS_BLIND !== '0' && !ctl.pillarMode) await blindPit(session, ctl, stats, deadline)
    await fightDragon(session, ctl, rep, stats, { deadline, perches: p.perches || 0 })
    if (ctl.aborted) return report()
    if (!rep.dragon.won) {
      return report(gameClock.now() >= deadline ? 'время вышло — позови mc_dragon ещё раз, продолжит с того места' : (rep.dragon.lost || 'дракон жив'))
    }
    // Победа: опыт, яйцо, домой.
    await sleep(3000)
    rep.xp = await collectXp(session, ctl, 8000)
    if (p.egg !== false) rep.egg = await takeEgg(session, ctl, rep)
    if (p.home !== false) rep.home = await goHome(session, ctl, rep)
    return report()
  } catch (e) {
    rep.error = String((e && e.message) || e)
    // Где сорвалось — первые строки стека (без них «reading 'id'» не найти).
    if (e && e.stack) {
      rep.errorAt = String(e.stack).split('\n').slice(1, 5).map(l => l.trim().replace(/^at /, '').replace(/\(.*[\\/]/, '(')).join(' ← ')
      console.error('[dragon] сорвалось:', e.stack)
    }
    return report(`сорвалось: ${rep.error}`)
  } finally {
    if (ctl.feed) { ctl.feed.close(); ctl.feed = null }
    bot.removeListener('death', onDeath)
    for (const t of taps) t()
    unguard()
    unfall()
    uncloud()
    unhit()
    unfb()
    unalarm()
    if (bot.physics && lookSpeed) { bot.physics.yawSpeed = lookSpeed[0]; bot.physics.pitchSpeed = lookSpeed[1] }
    trace.close({ died, won: !!(rep.dragon && rep.dragon.won), stopped: rep.stopped || null })
    bot.removeListener('respawn', onRespawn)
    clearControls(bot)
    // Стоять, опустив голову: между вызовами сторожа взгляда нет, а
    // эндермен, попавший в прицел праздного взгляда, злится сам.
    if (bot.entity) bot.look(bot.entity.yaw, -1.3, true).catch(() => {})
    try { session.updateMovements(true) } catch {}
  }
}

module.exports = { dragon }
