const { log, sleep, xyz, mobs, goals, gameClock, angerSet, inOwnTunnel, countOf, Vec3, fullCover, BF, centerIn, waitWatched, worlds, SIDES4 }: typeof import('./take-gold-block') = require('./take-gold-block')
const { walkUnlessBrute, pitCandidates, tradeBreach, tradeExecute, trapCandidates }: typeof import('./booth-trade') = require('./booth-trade')
const { lastGoldBreak, baitAim }: typeof import('./predict-gold') = require('./predict-gold')
const { pitsAwayFromBrutes, pitAngerWait }: typeof import('./brute-risk') = require('./brute-risk')
const { burrow, sealBody }: typeof import('./defense') = require('./defense')
const { planView }: typeof import('./sealed-gold') = require('./sealed-gold')

async function digTrap (session, ctl, st, until) {
  const bot = session.bot
  const SL: typeof import('.././sealed') = require('.././sealed')
  const S = st.sealedState
  if (!S) return null
  S.deadline = until
  S.noBonus = true
  for (let tries = 0; tries < 3 && !ctl.aborted && gameClock.now() < until - 20000; tries++) {
    const view = planView(bot, st)
    S.honest = S.honest || (require('.././nether-cover') as typeof import('.././nether-cover')).blind()
    if (S.honest) S.view = view
    const cands = trapCandidates(bot, view, S.own).slice(0, 16)
    if (!cands.length) { log('ловушка: места нет', { pigs: mobs(bot, 'piglin', 40).length }); return null }
    const me = bot.entity.position.floored()
    // Цель пути — ноги в H (голова в клетке рта M): отсюда видно камеру и можно бросить приманку.
    const goalMap = new Map(cands.map(b => [SL.key(b.H.x, b.H.y, b.H.z), b]))
    const xs = [me.x, ...cands.map(b => b.H.x)]; const ys = [me.y, ...cands.map(b => b.H.y)]; const zs = [me.z, ...cands.map(b => b.H.z)]
    const box = { x0: Math.min(...xs) - 10, x1: Math.max(...xs) + 10, y0: Math.max(5, Math.min(...ys) - 8), y1: Math.min(120, Math.max(...ys) + 8), z0: Math.min(...zs) - 10, z1: Math.max(...zs) + 10 }
    const hs = cands.map(b => b.H)
    const r = await SL.plan({
      cls: view.cls, dig: view.dig, own: S.own, box, maxNodes: 80000, vup: SL.fillerCount(bot) >= 6, vdown: !S.honest,
      starts: [{ x: me.x, y: me.y, z: me.z, g: 0 }],
      goal: (x, y, z) => goalMap.has(SL.key(x, y, z)),
      h: (x, y, z) => Math.min(...hs.map(t => Math.abs(x - t.x) + Math.abs(y - t.y) + Math.abs(z - t.z)))
    })
    if (!r.ok) { log('ловушка: пути нет', { cands: cands.length, nodes: r.nodes, why: r.why }); return null }
    const last = r.path.length ? r.path[r.path.length - 1].to : me
    const bo: any = goalMap.get(SL.key(last.x, last.y, last.z))
    log('ловушка: план', { feet: bo.P, mouth: bo.M, room: bo.C0, room2: bo.C2, dump: !!bo.dump, pigs: bo.pigs, brutes: bo.brutes, moves: r.path.length })
    st.doing = 'ловушка: путь'
    const ex = await SL.execute(session, ctl, r.path, S)
    if (!ex.ok) { S.fails.push('ловушка: ' + ex.why); continue }
    const built = await buildTrap(session, ctl, st, bo, S)
    if (!built) continue
    return built
  }
  return null
}

async function buildTrap (session, ctl, st, bo, S) {
  const bot = session.bot
  const SL: typeof import('.././sealed') = require('.././sealed')
  const step = what => {
    const f = bot.entity.position
    const nm = v => { const b = bot.blockAt(v); return b ? b.name : '?' }
    log('ловушка: шаг', { what, hp: Math.round(bot.health ?? 0), at: [+f.x.toFixed(2), +f.y.toFixed(2), +f.z.toFixed(2)], under: nm(f.offset(0, -0.5, 0)) })
  }
  step('дошёл')
  if (!(await centerIn(bot, bo.H))) { S.fails.push('ловушка: не встал в центр'); step('не в центре'); return null }
  st.doing = 'ловушка: жду злость'
  for (let w = 0; w < 40 && gameClock.now() - lastGoldBreak(st) < 33000 && !ctl.aborted; w++) await sleep(1000)
  // Камера, пока всё закрыто (над ней ещё пол пиглинов): низ C0, дальняя C2.
  st.doing = 'ловушка: камера'
  let bad = null
  const dig = async q => { const dr = await SL.digCell(bot, new Vec3(q.x, q.y, q.z)); if (dr !== 'ok' && dr !== 'air') bad = q.x + ',' + q.y + ',' + q.z + ': ' + dr; return !bad }
  if (!(await dig(bo.C0))) { S.fails.push('ловушка: ' + bad); return null }
  if (bo.C2 && !(await dig(bo.C2))) { bo.C2 = null; bad = null }
  // Вскрыть: сперва дальнюю (C2 над ней), приманку туда, потом ближнюю (C1) — и сразу вниз: пиглин
  // в C0 рядом с нашей головой, пока мы стоим в H, достал бы ударом.
  st.doing = 'ловушка: вскрыть'
  if (bo.C2 && !(await dig({ x: bo.C2.x, y: bo.C2.y + 1, z: bo.C2.z }))) { bo.C2 = null; bad = null }
  const aim = bo.C2 && countOf(bot, 'gold_ingot') > 0 ? baitAim(bot, bo) : null
  if (aim) {
    try { await bot.lookAt(aim, true); await sleep(80); await bot.toss(bot.registry.itemsByName.gold_ingot.id, null, 1); bo.baited = 1 } catch {}
  }
  if (!(await dig(bo.C1))) { S.fails.push('ловушка: ' + bad); return null }
  // Вниз: копаем P под ногами и падаем в него — теперь на 2 ниже пола камеры.
  st.doing = 'ловушка: вниз'
  if (!(await dig(bo.P))) { S.fails.push('ловушка: ' + bad); return null }
  S.own.add(SL.key(bo.P.x, bo.P.y, bo.P.z))
  for (let i = 0; i < 20 && bot.entity.position.y > bo.P.y + 0.1; i++) await sleep(50)
  step('внизу')
  if (bo.dump) {
    st.doing = 'ловушка: свалка'
    let ok = true
    for (const q of [bo.dump.Dh, bo.dump.D1, bo.dump.D2]) {
      const dr = await SL.digCell(bot, new Vec3(q.x, q.y, q.z))
      if (dr === 'ok' || dr === 'air') S.own.add(SL.key(q.x, q.y, q.z)); else { ok = false; break }
    }
    if (!ok) bo.dump = null
    await centerIn(bot, bo.P)
    step('свалка')
  }
  st.doing = 'ловушка: замкнуть'
  bo.sealed = await sealBody(bot, S, bo.dump ? [bo.dump.Dh, bo.dump.D1, bo.dump.D2] : [], [bo.M])
  await centerIn(bot, bo.P)
  step('замкнул ' + JSON.stringify(bo.sealed))
  if (bo.sealed.risky && bo.sealed.risky.length) { S.fails.push('ловушка: угол открыт наружу'); return null }
  st.doing = 'ловушка: торг'
  S.exposed = true
  bo.at = xyz(bot.entity.position.floored())
  return bo
}

async function prepareBarterCover (session, ctl, st, until) {
  const bot = session.bot
  const SL: typeof import('.././sealed') = require('.././sealed')
  const CM: typeof import('./cover-memory') = require('./cover-memory')
  let feet = bot.entity.position.floored()
  const air = at => SL.classOf(bot.blockAt(new Vec3(at.x, at.y, at.z))) === SL.AIR
  const firm = at => {
    const block = bot.blockAt(new Vec3(at.x, at.y, at.z))
    return fullCover(block) && ![SL.HOT, SL.FLUID, SL.FALL].includes(SL.classOf(block))
  }
  const reject = (why: string, n?: number) => {
    const position = bot.entity.position
    const diagnostic = { position: { x: position.x, y: position.y, z: position.z }, onGround: bot.entity.onGround }
    try {
      const { bodyObservation } = require('.././navigation/parkour') as typeof import('../navigation/parkour')
      const observation = bodyObservation(bot, position)
      const body = position.floored()
      return { ok: false as const, why, n, diagnostic: { ...diagnostic, ...observation, cells: observation.cells.slice(0, 24),
        breaches: SL.exposure(bot, new Set([SL.keyV(body), SL.keyV(body.offset(0, 1, 0))])).slice(0, 24) } }
    } catch (error) {
      return { ok: false as const, why, n, diagnostic: { ...diagnostic, error: String(error?.message || error).slice(0, 300) } }
    }
  }
  const active = () => !ctl.aborted && session.bot === bot && gameClock.now() < until && (bot.health ?? 0) > 0
  // Ответ стража (столб, коробка) или прыжок ещё идёт — дождаться опоры, а не отказывать сразу (Full44 06.10: четыре
  // отказа подряд за 0 с на y 51.4→52.2→53.2, 58 слитков так и не отданы).
  if (!bot.entity.onGround && active()) {
    if (ctl.waitReflex) await ctl.waitReflex()
    if (process.env.ND_GUARD !== '0') await (require('.././ne-guard') as typeof import('.././ne-guard')).waitIdle(bot).catch(() => null)
    for (let i = 0; i < 40 && active() && !bot.entity.onGround; i++) await sleep(100)
    feet = bot.entity.position.floored()
  }
  if (worlds.worldOf(bot) !== 'the_nether' || !active() || !bot.entity.onGround || !air(feet) || !air(feet.offset(0, 1, 0))) {
    return reject('тело не на сухом подтверждённом полу')
  }
  if (!firm(feet.offset(0, -1, 0))) {
    const known = new Set([...st.sealedState?.own || [], ...(require('.././tunnel') as typeof import('.././tunnel')).ownSet(session)])
    const candidates = SIDES4.map(([dx, dz]) => feet.offset(dx, 0, dz)).filter(at =>
      known.has(SL.keyV(at)) && known.has(SL.keyV(at.offset(0, 1, 0))) &&
      air(at) && air(at.offset(0, 1, 0)) && firm(at.offset(0, -1, 0)))
    for (const destination of candidates) {
      if (!active() || !bot.entity.onGround || !bot.entity.position.floored().equals(feet)) break
      if (ctl.waitReflex) await ctl.waitReflex()
      if (!active() || !air(destination) || !air(destination.offset(0, 1, 0)) || !firm(destination.offset(0, -1, 0))) break
      const moved = await (require('.././navigation/parkour') as typeof import('.././navigation/parkour')).executeJump(bot, ctl, destination.offset(.5, 0, .5), { allowWalk: true })
      if (moved.ok && active() && bot.entity.onGround && bot.entity.position.floored().equals(destination)) {
        feet = destination
        log('бартер: ушёл с рыхлого пола', { at: xyz(feet) })
        break
      }
    }
  }
  const head = feet.offset(0, 1, 0)
  const roof = feet.offset(0, 2, 0)
  const current = () => !ctl.aborted && gameClock.now() < until && (bot.health ?? 0) > 0 &&
    session.bot === bot && bot.entity.onGround && bot.entity.position.floored().equals(feet) && air(feet) && air(head) && firm(feet.offset(0, -1, 0))
  if (worlds.worldOf(bot) !== 'the_nether' || !current()) return reject('тело не на сухом подтверждённом полу')
  try { bot.pathfinder.setGoal(null) } catch {}
  bot.clearControlStates()
  const own = new Set([SL.keyV(feet), SL.keyV(head)])
  const S = { own, filled: new Set(), exposed: true, entry: xyz(feet), dug: 0, moves: 0,
    fills: 0, ores: 0, bonusBlocks: 0, goldPassed: 0, plans: 0, fails: [], planMs: 0, walks: 0 }
  const protectedNow = () => current() && CM.protectedGeometry(bot.entity.position, own, SL.exposure(bot, own), air, firm)
  let n = 0
  if (!protectedNow()) {
    if (SL.fillerCount(bot) < 1) return reject('нечем восстановить стены укрытия')
    st.doing = 'бартер: восстановить укрытие'
    const closed = await sealBody(bot, S, [], [], null, current)
    n += closed.n
    if (!current()) return reject('восстановление укрытия прервано', n)
    if (air(roof)) {
      if (await SL.fillCell(bot, roof)) { S.filled.add(SL.keyV(roof)); own.delete(SL.keyV(roof)); n++ }
    }
    if (!protectedNow()) return reject('стены или потолок физически не замкнуты', n)
  }
  S.exposed = false
  const historical = new Set([...st.sealedState?.own || [], ...(require('.././tunnel') as typeof import('.././tunnel')).ownSet(session)])
  for (const cell of historical) {
    const [x, y, z] = String(cell).split(',').map(Number)
    if ([x, y, z].every(Number.isInteger) && Math.abs(x - feet.x) + Math.abs(y - feet.y) + Math.abs(z - feet.z) < 96 && air({ x, y, z })) own.add(cell)
  }
  st.sealedState = S
  st.sealedDone = true
  st.towered = Math.max(st.towered || 0, 3)
  ;(require('.././tunnel') as typeof import('.././tunnel')).rememberOwn(session, own)
  log('бартер: укрытие подтверждено', { at: xyz(feet), placed: n, own: own.size })
  return { ok: true as const, n }
}

async function digPit (session, ctl, st, until) {
  const bot = session.bot
  const SL: typeof import('.././sealed') = require('.././sealed')
  const S = st.sealedState
  if (!S) return null
  S.deadline = until
  S.noBonus = true
  const readyPen = (require('./pen-trap') as typeof import('./pen-trap')).penHere(bot)
  if (readyPen) {
    S.exposed = SL.exposure(bot, S.own).length > 0
    return { ...readyPen, kind: 'pit', F: readyPen.Bf, W: readyPen.H, O: readyPen.lanes.find(l => l.k === 0).T }
  }
  const readyPit = (require('./booth-trade') as typeof import('./booth-trade')).currentPit(bot, S)
  if (readyPit) {
    S.exposed = true
    log('яма: использую готовую', { feet: readyPit.P, mouth: readyPit.M, pigs: readyPit.pigs })
    return readyPit
  }
  // S1d 07.10: злость от последнего золота (600 тиков) — переждать в своём штреке, потом к яме (s1d-G22-6: золото «окном», сразу
  // «яма: путь» 20 ходов — злые пиглины, 5 ударов, смерть на 24-й мин). Ломок «окном» стало много — ожидание по умолчанию.
  // S1f (проверка S1e (е)): ждать — цена: пиглинов, которых злит ломка (angerSet: в 16 бл.), нет — ждать нечего; есть — остаток
  // злости против риска (pitAngerWait). ND_PIT_ANGER_PRICE=0 — прежнее «всегда ждать».
  const leftAnger = lastGoldBreak(st) + 33000 - gameClock.now()
  let angerWait = leftAnger > 0 && inOwnTunnel(bot, S)
  if (angerWait && process.env.ND_PIT_ANGER_PRICE !== '0') {
    const w = pitAngerWait({ angry: angerSet(bot, null, false).length, hp: bot.health ?? 20, leftS: leftAnger / 1000, gear: (require('.././assess') as typeof import('.././assess')).gearOf((bot.inventory.slots || []).slice(5, 9)) })
    if (!w.wait) log('яма: злость от золота — не жду', { why: w.why })
    angerWait = w.wait
  }
  if (angerWait) {
    log('яма: злость от золота — жду в штреке', { s: Math.round((lastGoldBreak(st) + 33000 - gameClock.now()) / 1000) })
    const why = await waitWatched(session, ctl, Math.min(33000, lastGoldBreak(st) + 33000 - gameClock.now()))
    if (why || ctl.aborted) return null
  }
  // Снаружи (второй вызов кампании: тело вышло штреком к входу) — сперва ко входу своего штрека:
  { const me0 = bot.entity.position.floored()
    if (!S.own.has(SL.keyV(me0)) && S.entry && Math.hypot(S.entry.x - me0.x, S.entry.z - me0.z) + Math.abs(S.entry.y - me0.y) > 1) {
      const w = await walkUnlessBrute(session, ctl, new goals.GoalBlock(S.entry.x, S.entry.y, S.entry.z), 30000, { dig: false })
      log('яма: ко входу штрека', { entry: S.entry, ok: !!(w && w.ok), at: xyz(bot.entity.position.floored()) })
      S.exposed = true
    } }
  for (let tries = 0; tries < 3 && !ctl.aborted && gameClock.now() < until - 20000; tries++) {
    const view = planView(bot, st)
    S.honest = S.honest || (require('.././nether-cover') as typeof import('.././nether-cover')).blind()
    if (S.honest) S.view = view
    // Яма — не у дома брута из копии (S1d s1d-AB-4 B: план ямы в 39 ходах к 92,59,−87, в 7 бл. от брута 85,58,−88 — два удара на пути, смерть).
    const BH = (require('.././nether-route') as typeof import('.././nether-route')).bruteSpots(session)
    const cands = pitsAwayFromBrutes(pitCandidates(bot, view, S.own, BF.enabled() ? 64 : 40).filter(b => !(S.badPits && S.badPits.has(SL.key(b.M.x, b.M.y, b.M.z)))), BH).slice(0, 16)
    if (!cands.length) { log('яма: места у пиглинов нет', { pigs: mobs(bot, 'piglin', 40).length }); return null }
    const me = bot.entity.position.floored()
    const goalMap = new Map(cands.map(b => [SL.key(b.P.x, b.P.y, b.P.z), b]))
    const xs = [me.x, ...cands.map(b => b.P.x)]; const ys = [me.y, ...cands.map(b => b.P.y)]; const zs = [me.z, ...cands.map(b => b.P.z)]
    const box = { x0: Math.min(...xs) - 10, x1: Math.max(...xs) + 10, y0: Math.max(5, Math.min(...ys) - 8), y1: Math.min(120, Math.max(...ys) + 8), z0: Math.min(...zs) - 10, z1: Math.max(...zs) + 10 }
    const hs = cands.map(b => b.P)
    const pitPlan = extra => SL.plan({
      cls: view.cls, dig: view.dig, own: S.own, box, maxNodes: 80000, vup: SL.fillerCount(bot) >= 6, vdown: !S.honest, breachOk: tradeBreach(S),
      starts: [{ x: me.x, y: me.y, z: me.z, g: 0 }],
      goal: (x, y, z) => goalMap.has(SL.key(x, y, z)),
      h: (x, y, z) => Math.min(...hs.map(t => Math.abs(x - t.x) + Math.abs(y - t.y) + Math.abs(z - t.z))),
      ...extra
    })
    let r = await pitPlan({})
    // Тело в «чужом» кармане (ни одного хода со старта: кругом воздух не из своих) — пройти и вскрыть можно
    // только этот карман (localAir), дальше — как всегда (main 30.09: 9 золотых блоков, «яма: пути нет» ×6).
    let local = null
    if (!r.ok && r.nodes <= 1) {
      local = SL.localAir(bot)
      if (local) {
        r = await pitPlan({ openOk: local, breachOk: tradeBreach(S, (ck, nk) => local.has(nk)) })
        log('яма: старт из чужого кармана', { cells: local.size, ok: r.ok, nodes: r.nodes })
        if (!r.ok) local = null
      }
    }
    // Тело на открытой выработке (золото моста/двора: свои клетки, но кругом чужой воздух) — ни хода отсюда, и карман
    if (!r.ok && r.nodes <= 1 && S.own.size > 2) {
      const seen = new Set([SL.keyV(me)])
      const q = [{ v: me, d: 0 }]
      const starts = []
      for (let i = 0; i < q.length && q.length < 800; i++) {
        const { v, d } = q[i]
        for (const [dx, dy, dz] of SL.FACES) {
          const n = v.offset(dx, dy, dz)
          const nk = SL.keyV(n)
          if (seen.has(nk) || !S.own.has(nk)) continue
          const b = bot.blockAt(n)
          if (!b || b.boundingBox !== 'empty' || /lava|fire/.test(b.name)) continue
          seen.add(nk)
          q.push({ v: n, d: d + 1 })
          const fl = bot.blockAt(n.offset(0, -1, 0))
          if (fl && fl.boundingBox === 'block') starts.push({ x: n.x, y: n.y, z: n.z, g: (d + 1) * 2 })
        }
      }
      if (starts.length) {
        const r2 = await pitPlan({ starts })
        log('яма: старт из своего штрека', { own: S.own.size, starts: starts.length, ok: r2.ok, nodes: r2.nodes, start: r2.start })
        if (r2.ok && r2.start && !(r2.start.x === me.x && r2.start.y === me.y && r2.start.z === me.z)) {
          const w = await walkUnlessBrute(session, ctl, new goals.GoalBlock(r2.start.x, r2.start.y, r2.start.z), 30000, { dig: false })
          const f = bot.entity.position.floored()
          if (f.x === r2.start.x && f.y === r2.start.y && f.z === r2.start.z) r = r2
          else log('яма: к старту не дошёл', { start: r2.start, at: xyz(f), error: w && w.error })
        } else if (r2.ok) r = r2
      }
    }
    if (!r.ok) { log('яма: пути нет', { cands: cands.length, nodes: r.nodes, why: r.why }); return null }
    const last = r.path.length ? r.path[r.path.length - 1].to : me
    const bo: any = goalMap.get(SL.key(last.x, last.y, last.z))
    log('яма: план', { feet: bo.P, mouth: bo.M, dump: !!bo.dump, catch: bo.catch, pigs: bo.pigs, brutes: bo.brutes, moves: r.path.length })
    st.doing = 'яма: путь'
    S.exposed = SL.exposure(bot, S.own).length > 0
    const ex = await tradeExecute(session, ctl, r.path, S, local)
    if (!ex.ok) {
      S.fails.push('яма: ' + ex.why)
      const position = bot.entity.position
      log('яма: путь не завершён', { why: ex.why, done: ex.done, of: r.path.length, target: bo.P,
        at: { x: position.x, y: position.y, z: position.z }, onGround: bot.entity.onGround })
      continue
    }
    const step = what => {
      const f = bot.entity.position
      const nm = v => { const b = bot.blockAt(v); return b ? b.name : '?' }
      log('яма: шаг', { what, hp: Math.round(bot.health ?? 0), at: [+f.x.toFixed(2), +f.y.toFixed(2), +f.z.toFixed(2)], under: nm(f.offset(0, -0.5, 0)), inP: Math.floor(f.x) === bo.P.x && Math.floor(f.y) === bo.P.y && Math.floor(f.z) === bo.P.z })
    }
    step('дошёл')
    if (bo.dump) {
      st.doing = 'яма: свалка'
      let ok = true
      for (const c of [bo.dump.Dh, bo.dump.D1, bo.dump.D2]) {
        const dr = await SL.digCell(bot, new Vec3(c.x, c.y, c.z))
        if (dr === 'ok' || dr === 'air') S.own.add(SL.key(c.x, c.y, c.z)); else { ok = false; break }
      }
      if (!ok) bo.dump = null
      step('свалка')
    }
    // Тело — в центр своей клетки: рядом открыт столб свалки, и с края в него съехать.
    if (!(await centerIn(bot, bo.P))) { S.fails.push('яма: не встал в центр'); step('не в центре'); continue }
    st.doing = 'яма: замкнуть'
    bo.sealed = await sealBody(bot, S, bo.dump ? [bo.dump.Dh, bo.dump.D1, bo.dump.D2] : [], [], bo)
    await centerIn(bot, bo.P)
    step('замкнул ' + JSON.stringify(bo.sealed))
    if (bo.sealed.risky.length) { (S.badPits || (S.badPits = new Set())).add(SL.key(bo.M.x, bo.M.y, bo.M.z)); S.fails.push('яма: угол открыт наружу'); continue }
    if (gameClock.now() >= until || ctl.aborted) return null
    // Рот вскрывать, когда злость от золота остыла (600 тиков): злой арбалетчик стреляет в рот.
    st.doing = 'яма: жду злость'
    for (let w = 0; w < 40 && gameClock.now() - lastGoldBreak(st) < 33000 && !ctl.aborted; w++) await sleep(1000)
    st.doing = 'яма: рот'
    const mr = await SL.digCell(bot, new Vec3(bo.M.x, bo.M.y, bo.M.z))
    if (mr !== 'ok' && mr !== 'air') { S.fails.push('яма: рот ' + mr); continue }
    step('рот')
    st.doing = 'яма: торг'
    S.exposed = true
    bo.at = xyz(bot.entity.position.floored())
    return bo
  }
  return null
}

async function moveBarterSite (session, ctl, st, p, until) {
  const NR: typeof import('.././nether-route') = require('.././nether-route'); const SL: typeof import('.././sealed') = require('.././sealed'); const bot = session.bot
  if (!NR.enabled() || !NR.gridOf(session) || !st.sealedState || ctl.aborted || gameClock.now() > until - 20000 || (st.flowMoves || 0) >= 3) return false
  if ((bot.health ?? 20) < 16 || SL.fillerCount(bot) < 16) return false
  // Cool down behind cover, never at the open courtyard. The subsequent route is guarded and bounded.
  if (gameClock.now() - lastGoldBreak(st) < 33000) {
    if (!inOwnTunnel(bot, st.sealedState)) return false
    const why = await waitWatched(session, ctl, Math.min(33000, lastGoldBreak(st) + 33000 - gameClock.now()))
    if (why || ctl.aborted) return false
  }
  const view = SL.worldView(bot); const me = bot.entity.position
  const seen = st.flowVisited || (st.flowVisited = new Set())
  const pits = pitsAwayFromBrutes(pitCandidates(bot, view, st.sealedState.own, 64), (require('.././nether-route') as typeof import('.././nether-route')).bruteSpots(session))
    .filter(b => !b.brutes && !(st.sealedState.badPits && st.sealedState.badPits.has(SL.key(b.M.x, b.M.y, b.M.z))))
  const targets = pits.map(b => ({ ...b.P, r: 0, dy: 0, source: 'яма', pigs: b.pigs }))
  // Only the current bastion's known chest floors; no blind random walk and no outside-grid fallback.
  if (!targets.length) for (const [x, y, z] of p.knownChests || []) targets.push({ x, y, z, r: 4, dy: 1, source: 'этаж по карте' })
  for (const target of targets) {
    const key = `${target.x},${target.y},${target.z}`
    if (seen.has(key) || Math.hypot(target.x - me.x, target.z - me.z) < 6 && Math.abs(target.y - me.y) < 3) continue
    seen.add(key); st.flowMoves = (st.flowMoves || 0) + 1
    const sec = Math.min(60, Math.floor((until - gameClock.now()) / 1000))
    if (sec < 20) return false
    const rr: Partial<import('.././nether-route').NetherRouteResult> = await NR.routeTo(session, ctl, { ...target, timeoutSeconds: sec, ironOk: false, zoneExpo: 14,
      abortNear: { re: '^(piglin_brute|hoglin)$', r: 10 } }).catch(e => ({ ok: false, why: e.message }))
    for (const k of rr.own || []) st.sealedState.own.add(k)
    // @ts-expect-error в итоге routeTo поля s нет (время — seconds): в журнал идёт undefined; поведение не трогаю.
    log('бартер: смена места', { target, ok: rr.ok, why: rr.why, seconds: rr.s, moves: st.flowMoves })
    if (rr.ok) return true
    // A failed route can leave the body exposed; close up before giving the hands back.
    await burrow(session, ctl, st, 'бартер: смена места не вышла').catch(() => null)
    return false
  }
  return false
}

export { digTrap, buildTrap, prepareBarterCover, digPit, moveBarterSite }
