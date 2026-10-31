import { distance } from './common'
import { arenaRoom } from '../../../daemon/src/combat/team-wind'
import type { SwarmDriverCtx } from './common'

// Фланг ветра (пользователь 24.10: «если они стоят под тем, кого подкидывают, не откинут — отойти в сторону»): взрыв
// толкает от центра порыва к глазам цели (ServerExplosion), а порыв — там, где заряд встретил её тело; брошенный снизу бьёт
// в ноги и только подкидывает, брошенный полого сбоку — уносит вбок. Враг в воздухе или у края — до трёх свободных с
// зарядами, кто стоит под ним или снаружи, идут на сторону центра на пологий угол (дальше, чем он высоко); бросок решает
// тело само (combat/wind-out: вылетит ли от моего броска сейчас).
const FLANK_N = 3, FLANK_RANGE = 18, FLANK_MS = 2500
export function flankSpots(target: { x: number; y: number; z: number }, arena: { x: number; z: number; r: number }, floorY: number, shooters: { x: number; y: number; z: number }[]) {
  let ux = target.x - arena.x, uz = target.z - arena.z
  if (Math.hypot(ux, uz) < 1) { const c = shooters.reduce((a, p) => ({ x: a.x + p.x / shooters.length, z: a.z + p.z / shooters.length }), { x: 0, z: 0 }); ux = target.x - c.x; uz = target.z - c.z }
  const n = Math.hypot(ux, uz) || 1; ux /= n; uz /= n
  const h = Math.max(0, target.y - floorY), back = Math.min(12, 5 + 1.5 * h)
  // Плохой угол: ближе по горизонтали, чем 1.5 высоты (снизу — в ноги), или не со стороны центра (толкнёт внутрь).
  const bad = (p: { x: number; z: number }) => Math.hypot(p.x - target.x, p.z - target.z) < Math.max(3, 1.5 * h) || (p.x - target.x) * ux + (p.z - target.z) * uz > -2
  const spots = [0, -1, 1].map(k => ({ x: target.x - ux * back - uz * 3 * k, y: floorY, z: target.z - uz * back + ux * 3 * k }))
    .map(p => { const m = Math.max(Math.abs(p.x - arena.x), Math.abs(p.z - arena.z)), lim = arena.r - 2; return m > lim ? { x: arena.x + (p.x - arena.x) * lim / m, y: p.y, z: arena.z + (p.z - arena.z) * lim / m } : p })
  return { spots, bad, out: { x: ux, z: uz }, back }
}

/** An observation may start one short chain per team; it never stops an existing fight or defence. */
export function swarmWind(sw: SwarmDriverCtx) {
  const { bots, pos, now, alive, teamOf, arena, log } = sw
  // До края: в Колизее — до внешней стены по эллипсу (combat/team-wind arenaRoom).
  const edgeRoom = (q: { x: number; z: number }) => arenaRoom(arena, q)
  const pending = new Map<string, object>()
  const attempted = new Map<string, string>()
  let generation = sw.generation
  const detail = reply => reply?.detail || reply || {}
  const protectedAction = b => b.maceDefense?.until > now() || b.climbing || pos[b.name]?.gliding ||
    (/^(lava_escape|dodge_blast|clear_web|evade|juke|take_cover|douse_lava|pearl_to|wind_jump|wind_leap|fly_to|burrow|block_behind|peek_shot)$/.test(b.last?.m || '') || b.shieldHold && b.last?.m === 'swarm_hold') && b.last?.pending !== false
  // Preflight is a query: panic() caches the strategic verdict and must not run for an unused wind opportunity.
  // Отходящий по плану (flee, recover) — не в наряд: караул и фланг слали его обратно к человеку под лук (игра пользователя 24.10).
  // Вырезает союзника из паутины (dangers webRescue) — не уводить фланом (Codex 25.10, C-HELPER-FAILURE: g летел на ярус, q так и сидел).
  const available = b => alive(b.name) && !!pos[b.name]?.p && !b.swarmReserved && !b.webRescue && !pos[b.name]?.combo && !protectedAction(b) && !/^(flee|recover)$/.test(b.swarmTask?.kind || '')
  // В рукопашной — не трогать ходом на точку (бой роя 24.10: караул и разгон прервали goto 54 боя из 89, ⚔ cancelled by goto).
  const meleeBusy = b => b.last?.m === 'fight' && b.last.pending === true
  async function windObserve(b, sightings, seenAt = now()) {
    const round = sw.generation, team = teamOf(b), key = `${round}:${team}`, token = {}, reserved: any[] = []
    const current = () => round === sw.generation && alive(b.name)
    const charged = o => (pos[o.name]?.inv?.wind_charge || 0) > 0 || pos[o.name]?.offHand?.item === 'wind_charge'
    const roster = bots.filter(o => teamOf(o) === team && alive(o.name) && pos[o.name]?.p)
    if (pending.has(key) || !current() || now() - seenAt > 1000 || !roster.some(o => charged(o) && available(o))) return false
    const target = (sightings || []).filter(e => e.visible === true && sw.hostile(b, e.id))
      .sort((a, c) => distance(a.position, pos[b.name].p) - distance(c.position, pos[b.name].p))[0]
    if (!target) return false
    if (generation !== round) { attempted.clear(); generation = round }
    const scene = JSON.stringify([target.id, target.position, target.velocity, target.equipment,
      roster.map(o => [o.name, pos[o.name].p, pos[o.name].v, pos[o.name].velocity, pos[o.name].armor,
        pos[o.name].inv?.wind_charge || 0, pos[o.name].offHand, available(o)])])
    if (attempted.get(key) === scene) return false
    pending.set(key, token)
    let planMs = 0
    try {
      // A cold native forecast may miss its first launch window; one measured replan replaces that stale schedule.
      for (let attempt = 0; attempt < 2; attempt++) {
        const reports = await Promise.all(roster.map(async o => {
          const start = now(), reply = detail(await o.c.call('wind_report', { target: target.id }).catch(() => null))
          return { bot: o, ...reply, at: now(), ms: now() - start }
        }))
        if (!current()) return false
        const bodies = reports.filter(r => r.ok && r.report && Number.isSafeInteger(r.gameTick))
        const ready = bodies.filter(r => r.ready && available(r.bot) && charged(r.bot))
        if (!ready.length) return false
        const rtt = Math.max(0, ...bodies.map(r => r.ms)), leadTicks = Math.max(2, Math.ceil((rtt + planMs) / 50) + 1)
        if (leadTicks > 20) return false
        const start = now(), proposal = detail(await b.c.call('enemy_wind_plan', {
          target: target.id, throwers: ready.map(r => r.report), allies: bodies.map(r => r.report), arena, leadTicks, maxShots: 2
        }).catch(() => null))
        planMs = now() - start
        if (!current()) return false
        const plan = proposal.plan
        if (proposal.ok || proposal.why === 'no_useful_native_chain') attempted.set(key, scene)
        if (!proposal.ok || !plan?.shots?.length || plan.shots.length > 3) return false
        const currentTick = Math.max(...bodies.map(r => r.gameTick + Math.ceil((now() - r.at) / 50)))
        if (plan.shots.some(s => !Number.isSafeInteger(s.fireTick) || s.fireTick <= currentTick + Math.ceil(rtt / 50))) continue
        const shooters = [...new Set<string>(plan.shots.map(s => s.thrower))].map(id => ready.find(r => r.bot.name === id)?.bot)
        if (shooters.some(o => !o || !available(o) || sw.panic(o))) return false
        for (const o of shooters) { o.swarmReserved = token; reserved.push(o) }
        const results = await Promise.all(shooters.map(async o => detail(await o.c.call('wind_out', { plan, arena, allies: bodies.map(r => r.report) }).catch(e => ({ fired: false, why: e.message })))))
        if (!current()) return false
        const fired = results.filter(r => r.fired).length, confirmed = results.filter(r => r.launchConfirmed).length, bursts = results.filter(r => r.burstSeen).length
        log(`🌬 ${team} → ${target.id}: цепочка ${fired}/${shooters.length}, запуск подтверждён ${confirmed}, всплесков видно ${bursts}`)
        return fired > 0
      }
      attempted.delete(key)
      return false
    } finally {
      for (const o of reserved) if (o.swarmReserved === token) delete o.swarmReserved
      if (pending.get(key) === token) pending.delete(key)
    }
  }
  // Караул жемчуга (тело: combat/pearl-watch): враг бросил жемчуг — двое ближайших свободных бойцов команды идут в точку
  // приземления, пока он летит; бой подхватит их там (wind-out у края, удар в момент появления). Один жемчуг — один вызов.
  const pearlsSeen = new Map<string, number>()
  function pearlObserve(b, pearls) {
    for (const pl of pearls || []) {
      const key = `${sw.generation}:${pl.owner}:${pl.id}`
      if (pearlsSeen.has(key) || !sw.hostile(b, pl.owner)) continue
      pearlsSeen.set(key, now()); if (pearlsSeen.size > 200) pearlsSeen.delete(pearlsSeen.keys().next().value!)
      const team = teamOf(b), at = { x: pl.at.x, y: Math.round(pl.at.y), z: pl.at.z }
      if (arena && (Math.abs(at.x - arena.x) > arena.r - 1 || Math.abs(at.z - arena.z) > arena.r - 1 || at.y <= (arena.killY ?? -64))) { log(`🟣 ${pl.owner}: жемчуг за край (${Math.round(at.x)},${at.y},${Math.round(at.z)}) — не встречаем`); continue }
      // Засада (пользователь 24.10: «заранее там взлетают, чтобы сразу долбануть булавой и ваншотнуть»): до трёх с булавой и
      // зарядом в 30 бл. — к точке любым способом (бег, ветер, свой жемчуг — выбирает тело: combat/pearl-ambush) и взлёт к
      // его появлению, с разных сторон (120°); без булавы — один, кто добежит (бег 5.6 бл./с, 3 бл. на удар).
      const reach = 3 + 5.6 * pl.eta / 20
      // Ответ на жемчуг — шанс на ваншот, важнее мелких дел: снимает с караула, разгона, полёта на насест, подъёма и хода
      // (бой роя 24.10, испытание «жемчуг вверх»: на полёт 85–113 т. «к точке никто» — 9–14 своих в fly_to, с булавой в
      // 4–13 бл. «занят»). Не трогает рукопашную, щит от булавы, уворот, выход из лавы и паутины, связку.
      const hardReaction = o => o.maceDefense?.until > now() || /^(lava_escape|dodge_blast|clear_web|evade|juke|douse_lava|burrow|block_behind|pearl_ambush|pearl_trap|boost_lance)$/.test(o.last?.m || '') && o.last?.pending !== false
      // Кого враг уже достаёт (в 8 бл.), тот не встречает жемчуг: дерётся или уходит сам (игра пользователя 24.10).
      const pressed = o => sw.boardOf(o).enemies().some(e => now() - e.seenAt < 1500 && distance(e.position, pos[o.name].p) <= 8)
      const free = bots.filter(o => teamOf(o) === team && alive(o.name) && !!pos[o.name]?.p && !o.webRescue && !pos[o.name]?.combo && !hardReaction(o) && !meleeBusy(o) && !sw.panic(o) && !pressed(o))
      const smashers = free.filter(o => (pos[o.name].inv?.mace || 0) > 0 && (pos[o.name].inv?.wind_charge || 0) > 0 && distance(pos[o.name].p, at) <= 30)
        .sort((x, y) => distance(pos[x.name].p, at) - distance(pos[y.name].p, at)).slice(0, 2) // двое: третий ближний — ловушка или зелье (бой 24.10: их набор был только в 30–90 бл.)
      const walkers = free.filter(o => !smashers.includes(o) && distance(pos[o.name].p, at) <= reach)
        .sort((x, y) => distance(pos[x.name].p, at) - distance(pos[y.name].p, at)).slice(0, smashers.length ? 1 : 2)
      log(`🟣 ${pl.owner} бросил жемчуг → ${Math.round(at.x)},${at.y},${Math.round(at.z)} через ${pl.eta} т. (видел ${b.name}; стазис 3×1 поймал бы: ${pl.stasis ? 'да' : 'нет'}); засада: ${smashers.map(o => `${o.name} (${distance(pos[o.name].p, at).toFixed(0)} бл.)`).join(', ') || 'нет булав'}; встречают: ${walkers.map(o => `${o.name} (${distance(pos[o.name].p, at).toFixed(0)} бл.)`).join(', ') || '—'}`)
      // Срок — по стенным часам (тело считает так же): now() драйвера может быть виртуальным (arena/server)
      const seenAt = Date.now(), base = Math.random() * Math.PI * 2
      smashers.forEach((o, k) => {
        const token = {}; o.swarmReserved = token
        void o.c.call('pearl_ambush', { owner: pl.owner, at: pl.at, eta: pl.eta, seenAt, side: base + k * 2 * Math.PI / 3, arena })
          .then(r => { const d = r?.detail || r || {}; log(`🟣🔨 ${o.name} → ${pl.owner}: ${d.ok ? (d.hit ? `удар булавой в точке появления${d.fall ? ' с ' + d.fall + ' бл.' : ''}${d.dealt != null ? ', снял ' + Math.round(d.dealt) : ''}` : 'взлетел, мимо') : 'не взлетел — ' + (d.why || r?.error || '?')} (${d.travel || '—'})`) })
          .catch(() => {}).finally(() => { if (o.swarmReserved === token) delete o.swarmReserved })
      })
      // Подброс в точке появления — двое дальних с зарядами (до 24 бл.; бросок рядом с боем, не эксклюзивно).
      const poppers = free.filter(o => !smashers.includes(o) && !walkers.includes(o) && (pos[o.name].inv?.wind_charge || 0) > 0 && distance(pos[o.name].p, at) <= 24)
        .sort((x, y) => distance(pos[x.name].p, at) - distance(pos[y.name].p, at)).slice(0, 2)
      for (const o of poppers) void o.c.call('pearl_pop', { owner: pl.owner, at: pl.at, contact: pl.contact, block: pl.block, eta: pl.eta, seenAt })
        .then(r => { const d = r?.detail || r || {}; log(`🟣🌬 ${o.name} → ${pl.owner}: подброс в точке появления — ${d.ok ? `бросил, всплеск ${d.lateMs >= 0 ? '+' : ''}${d.lateMs} мс от появления` : d.why || r?.error || '?'}`) }).catch(() => {})
      // Ловушка и подкоп (combat/pearl-trap): с засадой — паутина в клетку появления (держит его под булавой; лава — нет:
      // засадчик падает туда же); без засады — лава, паутина или подкоп блока удара (яма / жемчуг в пустоту), что успеет.
      const used = new Set([...smashers, ...walkers, ...poppers])
      const inv = o => pos[o.name].inv || {}
      const trapKit = o => (inv(o).cobweb || 0) > 0 || !smashers.length && ((inv(o).lava_bucket || 0) > 0 || Object.keys(inv(o)).some(n => /_pickaxe$/.test(n)))
      const trapper = free.filter(o => !used.has(o) && trapKit(o) && distance(pos[o.name].p, at) <= 4.2 + 5.6 * pl.eta / 20 - 1)
        .sort((x, y) => distance(pos[x.name].p, at) - distance(pos[y.name].p, at))[0]
      // Разгон стрелой к точке появления (пользователь 24.10: «стрелами тоже кидать друг друга к жемчугу»; combat/arrow-boost):
      // место и тик известны, и первые тики он стоит. Копейщик — в 7 бл. от точки со своей стороны, 1–3 лучника — за ним по
      // той же линии; когда стрелять — считают тела по своим часам (at, eta). Только с запасом на подбег (от 2 с полёта).
      const lancerOk = o => Object.entries(inv(o)).some(([n, c]) => /_spear$/.test(n) && Number(c) > 0)
      const archerOk = o => (inv(o).bow || 0) > 0 && (inv(o).arrow || 0) > 0
      const runFor = (o, spot) => distance(pos[o.name].p, spot) <= 5.6 * (pl.eta / 20 - 1.8)
      const lancer = pl.eta >= 40 ? free.filter(o => !used.has(o) && o !== trapper && lancerOk(o)).sort((x, y) => distance(pos[x.name].p, at) - distance(pos[y.name].p, at))[0] : null
      if (lancer) {
        let ux = pos[lancer.name].p.x - at.x, uz = pos[lancer.name].p.z - at.z
        const n = Math.hypot(ux, uz) || 1; ux /= n; uz /= n
        const spot = (k: number, side = 0) => ({ x: at.x + ux * k - uz * side, y: at.y, z: at.z + uz * k + ux * side })
        const S = spot(BOOST_D), spots = [spot(BOOST_D + 3, -.6), spot(BOOST_D + 3, .6), spot(BOOST_D + 4.5)]
        const archers = runFor(lancer, S) ? free.filter(o => !used.has(o) && o !== lancer && o !== trapper && archerOk(o)).sort((x, y) => distance(pos[x.name].p, S) - distance(pos[y.name].p, S)).slice(0, 3).filter((o, k) => runFor(o, spots[k])) : []
        if (archers.length) {
          const crew = [lancer, ...archers]; crew.forEach(o => used.add(o))
          const tokens = crew.map(o => { const t = {}; o.swarmReserved = t; return t })
          const draws = BOOST_DRAW.slice(0, archers.length), maxDraw = Math.max(...draws)
          const flight = archers.map((o, k) => Math.ceil((k < 2 ? 3 : 4.5) / arrowSpeed(draws[k])))
          log(`🟣🏹 ${team} разгон к точке появления ${pl.owner}: копьё ${lancer.name}, лучники ${archers.map(o => o.name).join(', ')} (${pl.eta} т.)`)
          void (async () => {
            const lance = lancer.c.call('boost_lance', { foe: pl.owner, at: pl.at, eta: pl.eta, stand: S, lead: maxDraw + 4, from: archers.map(o => o.name) })
            const shots = await Promise.all(archers.map((o, k) => o.c.call('boost_shot', { ally: lancer.name, foe: pl.owner, at: pl.at, eta: pl.eta, stand: spots[k], draw: draws[k], lag: Math.max(...flight) - flight[k], wait: maxDraw - draws[k] }).catch(err => ({ detail: { why: err.message } }))))
            const r = await lance.catch(err => ({ detail: { why: err.message } })), d = r?.detail || r || {}
            log(`🟣🏹 ${lancer.name} → ${pl.owner}: ${d.hit ? 'удар копьём в точке появления' : 'без удара' + (d.why ? ' — ' + d.why : '')}, скорость ${d.vmax ?? '?'} бл/т; стрелы: ${shots.map((s: any) => { const x = s?.detail || s || {}; return x.ok ? (x.hit ? 'попал' : 'мимо') : x.why || '?' }).join(', ')}`)
          })().finally(() => crew.forEach((o, k) => { if (o.swarmReserved === tokens[k]) delete o.swarmReserved }))
        }
      }
      // Зелье в точку появления (combat/pearl-ambush pearlPotion): ближайший в 16 бл. со взрывным или оседающим — вредное
      // ли оно, решает тело. Бросок с места, без хода — не эксклюзивно, как подброс.
      const potter = free.filter(o => !used.has(o) && o !== trapper && ((inv(o).lingering_potion || 0) > 0 || (inv(o).splash_potion || 0) > 0) && distance(pos[o.name].p, at) <= 16)
        .sort((x, y) => distance(pos[x.name].p, at) - distance(pos[y.name].p, at))[0]
      if (potter) void potter.c.call('pearl_potion', { owner: pl.owner, at: pl.at, eta: pl.eta })
        .then(r => { const d = r?.detail || r || {}; log(`🟣🧪 ${potter.name} → ${pl.owner}: ${d.ok ? `${d.kind === 'lingering_potion' ? 'облако' : 'брызги'} ${d.potion} в точку появления, ${d.lateMs >= 0 ? '+' : ''}${d.lateMs} мс` : 'не бросил — ' + (d.why || r?.status)}`) }).catch(() => {})
      {
        const near = (f: (o: any) => boolean) => { const xs = free.filter(o => !used.has(o) && f(o)); return xs.length ? Math.min(...xs.map(o => distance(pos[o.name].p, at))).toFixed(0) + ' бл.' : 'нет' }
        log(`🟣· ${pl.owner}: ловушка ${trapper?.name || 'нет (ближайший с набором ' + near(trapKit) + ')'}, зелье ${potter?.name || 'нет (' + near(o => (inv(o).lingering_potion || 0) + (inv(o).splash_potion || 0) > 0) + ')'}, разгон ${lancer ? lancer.name : 'нет'}`)
      }
      // Никто не пошёл — почему (бой роя 24.10: на полёты 78–88 т. «засада: нет булав, встречают: —», ловушек 0).
      if (!smashers.length && !trapper && !walkers.length && !potter) {
        const mine = bots.filter(o => teamOf(o) === team && alive(o.name) && pos[o.name]?.p), near = (xs: any[]) => xs.length ? Math.min(...xs.map(o => distance(pos[o.name].p, at))).toFixed(0) + ' бл.' : 'нет'
        const why = (o: any) => pos[o.name]?.combo ? 'связка' : hardReaction(o) ? `реакция ${o.maceDefense?.until > now() ? 'щит от булавы' : o.last?.m}` : meleeBusy(o) ? 'рукопашная' : sw.panic(o) ? 'паника' : 'свободен'
        const tally: Record<string, number> = {}; for (const o of mine) tally[why(o)] = (tally[why(o)] || 0) + 1
        log(`🟣∅ ${pl.owner}: к точке никто (${pl.eta} т., успеть с ${reach.toFixed(0)} бл.) — ${Object.entries(tally).map(([k, n]) => `${k} ${n}`).join(', ')}; ближайший свободный ${near(free)}, с булавой и зарядом ${near(mine.filter(o => (inv(o).mace || 0) > 0 && (inv(o).wind_charge || 0) > 0))}, с паутиной ${near(mine.filter(o => (inv(o).cobweb || 0) > 0))}`)
      }
      if (trapper) {
        const token = {}; trapper.swarmReserved = token
        void trapper.c.call('pearl_trap', { owner: pl.owner, id: pl.id, at: pl.at, contact: pl.contact, block: pl.block, eta: pl.eta, seenAt, lava: !smashers.length, dig: !smashers.length })
          .then(r => { const d = r?.detail || r || {}; log(`🟣🕸 ${trapper.name} → ${pl.owner}: ${d.ok ? (d.kind === 'lava' ? 'лава в точку появления' : d.kind === 'web' ? 'паутина в точку появления' : `подкоп ${d.dug} бл.${d.lost ? ' — жемчуг в пустоту' : d.drop != null ? `, он упадёт на ${d.drop} бл. ниже` : ''}`) + ` (запас ${-(d.lateMs ?? 0)} мс)` : 'ловушка не вышла — ' + (d.why || r?.error || '?')}`) })
          .catch(() => {}).finally(() => { if (trapper.swarmReserved === token) delete trapper.swarmReserved })
      }
      for (const o of walkers) {
        const token = {}; o.swarmReserved = token
        void sw.go(o, at, 1.5, Math.max(2, Math.ceil(pl.eta / 20) + 2)).catch(() => {}).finally(() => { if (o.swarmReserved === token) delete o.swarmReserved })
      }
    }
  }
  const flankAt = new Map<string, number>()
  function windFlank(b, sightings) {
    if (!arena || process.env.ND_WIND_FLANK === '0') return
    // Лук тоже: стрела толкает вдоль своего полёта (AbstractArrow.doKnockback — «Отдача» ×0.6 на уровень, плюс обычный
    // отброс от попадания), подброшенного в воздухе — на несколько блоков; со стороны центра — наружу.
    const team = teamOf(b), inv = o => pos[o.name]?.inv || {}
    const charged = o => (inv(o).wind_charge || 0) > 0 || pos[o.name]?.offHand?.item === 'wind_charge' || (inv(o).bow || 0) > 0 && ((inv(o).arrow || 0) + (inv(o).tipped_arrow || 0) + (inv(o).spectral_arrow || 0)) > 0
    for (const e of sightings || []) {
      // Ник сквозь уступ — тоже место: на ярусе выше его прямо не видно никому снизу (ниже — только для яруса).
      if (e.visible !== true && !e.nametag || !sw.hostile(b, e.id) || !e.position) continue
      const key = `${team}:${e.id}`
      if (now() - (flankAt.get(key) || 0) < FLANK_MS) continue
      const room = edgeRoom(e.position)
      // Стоит на ярусе выше нас (гребень Колизея) — фланг на его ярусе со стороны центра: с поля его закрывает уступ, а на 18 бл.
      // никого нет (стенд ветра 25.10: «cand:far / cand:los» — по бегущему у края ни одного броска). Подняться — дальше, до 48 бл.
      const low = Math.min(...bots.filter(o => teamOf(o) === team && pos[o.name]?.p).map(o => pos[o.name].p.y))
      const tier = !e.airborne && (e.velocity?.y || 0) <= .5 && e.position.y - low > 2.5
      if (e.visible !== true && !tier) continue
      const crew = bots.filter(o => teamOf(o) === team && available(o) && charged(o) && !sw.panic(o) && distance(pos[o.name].p, e.position) <= (tier ? 64 : FLANK_RANGE) && !meleeBusy(o))
      // Один боец (чемпион) — не рой: его фланг уводил из боя (стенд 24.10 14:48 — по 2–3 раза в секунду). На ярус — и один свободный:
      // снизу заряд упирается в уступ (стенд ветра 25.10: none:blocked — половина отказов).
      if (crew.length < (tier ? 1 : 2)) continue
      const floorY = tier ? e.position.y : Math.min(...crew.map(o => pos[o.name].p.y))
      // Подброшен, а не прыгнул: прыжок — 0.42 бл./т. вверх, обычный в бою; выше 2.5 бл. над полом — уже не прыжок.
      const airborne = !tier && ((e.velocity?.y || 0) > .5 || e.position.y - floorY > 2.5)
      if (!airborne && room > (tier ? 8 : 5)) continue
      const { spots, bad } = flankSpots(e.position, arena, floorY, crew.map(o => pos[o.name].p))
      // На ярусе — «плохо» стоит и тот, кто ниже его на 2+ бл.: снизу уступ закрывает.
      const wrong = tier ? (p: any) => bad(p) || p.y < e.position.y - 2 : bad
      const movers = crew.filter(o => wrong(pos[o.name].p)).sort((x, y) => distance(pos[x.name].p, spots[0]) - distance(pos[y.name].p, spots[0])).slice(0, FLANK_N)
      if (!movers.length) continue
      flankAt.set(key, now())
      log(`🌬↔ ${team} → ${e.id}${airborne ? ' в воздухе' : tier ? ' на ярусе' : ' у края'} (${room.toFixed(0)} бл. до края): на фланг ${movers.map((o, k) => `${o.name} ${distance(pos[o.name].p, spots[k]).toFixed(0)} бл.`).join(', ')}`)
      movers.forEach((o, k) => {
        const token = {}; o.swarmReserved = token
        // На ярус — время по пути и с элитрами (пользователь 25.10: «научи вставать на мой ярус со стороны центра»): 2 с пешком
        // не поднимали с поля на 30 бл. ни разу, и снизу заряд по гребню не попадает (стенд: 15 «out?» мимо).
        const far = distance(pos[o.name].p, spots[k]), m = pos[o.name]
        const wings = (m.inv?.elytra || m.armor?.torso === 'elytra') && (m.inv?.firework_rocket || 0) >= 5
        const move = !tier ? sw.go(o, spots[k], 1.5, 2)
          : wings ? o.c.call('fly_to', { at: spots[k], timeoutSeconds: 12, arena })
          : o.c.call('goto', { ...spots[k], range: 2, climb: true, timeoutSeconds: Math.min(15, Math.max(4, Math.ceil(far / 3))), arena, _hunt: true })
        void Promise.resolve(move)
          .then(r => { if (tier) log(`🌬↔ ${o.name}: на ярус к ${e.id} ${wings ? 'на элитрах' : 'пешком'} — ${detail(r).ok || r?.status === 'done' ? 'дошёл' : detail(r).why || r?.status || '?'}`) })
          .catch(() => {}).finally(() => { if (o.swarmReserved === token) delete o.swarmReserved })
      })
    }
  }
  // Караул булав (пользователь 24.10: «2–3 бота с булавой и зарядами держатся в 6–12 бл. от цели по разные стороны»): жемчуг
  // врага ловится, только если засадчик успевает — взлёт 1.15 с плюс подбег (сцена try-pearl-ambush: из 4 бл. — 9 из 10
  // ваншотов, из 13–30 — ни одного). На каждого видимого врага — три сектора по 120°; пустой сектор занимает ближайший
  // свободный с булавой и зарядом, не в рукопашной (дальше 5 бл.), в 9 бл. от врага. Раз в 2 с на врага.
  const sentryAt = new Map<string, number>()
  const SENTRY_R = 9, SENTRY_MIN = 6, SENTRY_MAX = 12, SENTRY_TEAM = 3
  function sentries(b, sightings) {
    if (process.env.ND_PEARL_SENTRY === '0') return
    const team = teamOf(b)
    const smasher = o => (pos[o.name]?.inv?.mace || 0) > 0 && (pos[o.name]?.inv?.wind_charge || 0) > 0
    for (const e of sightings || []) {
      if (e.visible !== true || !sw.hostile(b, e.id) || !e.position) continue
      const key = `${team}:${e.id}`
      if (now() - (sentryAt.get(key) || 0) < 2000) continue
      sentryAt.set(key, now())
      const maces = bots.filter(o => teamOf(o) === team && alive(o.name) && pos[o.name]?.p && smasher(o))
      const sector = (p: any) => { const a = Math.atan2(p.z - e.position.z, p.x - e.position.x); return ((Math.round(a / (2 * Math.PI / 3)) % 3) + 3) % 3 }
      const holding = new Map<any, number>(maces.filter(o => { const d = distance(pos[o.name].p, e.position); return d >= 4 && d <= SENTRY_MAX + 2 }).map(o => [o, sector(pos[o.name].p)]))
      const remaining = new Map<number, number>()
      for (const k of holding.values()) remaining.set(k, (remaining.get(k) || 0) + 1)
      const held = new Set(remaining.keys())
      const empty = [0, 1, 2].filter(k => !held.has(k))
      if (held.size >= 3 || !empty.length) continue
      // Караул — не больше 3 на команду (бой 24.10, булава у всех: кольца по 3 на каждого врага — вся команда в карауле,
      // 4 минуты 7 на 6 без смертей).
      const posted = maces.filter(o => o.swarmSentry && o.swarmReserved === o.swarmSentry).length
      if (posted >= SENTRY_TEAM) continue
      // Пост ещё в силе (тот же враг, сдвинулся меньше 3 бл.) — не переставлять: иначе каждые 2 с новый приказ рвал его ход.
      const posted0 = o => o.sentryPost?.foe === e.id && distance(o.sentryPost.at, e.position) < 3
      const free = maces.filter(o => available(o) && !meleeBusy(o) && !posted0(o) && !sw.panic(o) && distance(pos[o.name].p, e.position) > 5 && distance(pos[o.name].p, e.position) <= 40)
      const sent: string[] = []
      for (const k of empty.slice(0, Math.min(3 - Math.min(held.size, 2), SENTRY_TEAM - posted))) {
        const a = k * 2 * Math.PI / 3
        let spot = { x: e.position.x + SENTRY_R * Math.cos(a), y: e.position.y, z: e.position.z + SENTRY_R * Math.sin(a) }
        if (arena) { const m = Math.max(Math.abs(spot.x - arena.x), Math.abs(spot.z - arena.z)), lim = arena.r - 2; if (m > lim) spot = { x: arena.x + (spot.x - arena.x) * lim / m, y: spot.y, z: arena.z + (spot.z - arena.z) * lim / m } }
        // Moving the last holder to an empty sector adds no coverage and interrupts its current approach.
        const o = free.filter(q => !sent.includes(q.name) && (!holding.has(q) || remaining.get(holding.get(q)!)! > 1)).sort((x, y) => distance(pos[x.name].p, spot) - distance(pos[y.name].p, spot))[0]
        if (!o || distance(spot, e.position) < SENTRY_MIN - 1) continue
        sent.push(o.name)
        const from = holding.get(o)
        if (from !== undefined) remaining.set(from, remaining.get(from)! - 1)
        const token = {}; o.swarmReserved = token; o.swarmSentry = token; o.sentryPost = { foe: e.id, at: { ...e.position } }
        void sw.go(o, spot, 2, 2).catch(() => {}).finally(() => { if (o.swarmReserved === token) delete o.swarmReserved; if (o.swarmSentry === token) delete o.swarmSentry })
      }
      if (sent.length) log(`🛡 ${team} караул булав у ${e.id}: держат ${held.size} из 3 секторов, иду ${sent.join(', ')}`)
    }
  }
  // Разгон стрелой (пользователь 24.10: «один бот другого стрелой ускоряет, и тот копьём ваншотит»; combat/arrow-boost):
  // копейщик встаёт в 7 бл. от врага и ждёт с копьём в «использовании», прыгая на месте; 1–3 лучника за его спиной по линии
  // на врага пускают в него слабые стрелы «Отдачи» — все в один тик (lag — разница полётов), каждая следующая больнее
  // прошлой (не отскочит в неуязвимости). Сцена try-arrow-boost: одна стрела — 1.3 бл/т, железо — ваншот; две — 2.3.
  // ND_ARROW_BOOST=0 — выкл.
  const boostAt = new Map<string, { x: number; y: number; z: number }>(), boosting = new Set<string>()
  const BOOST_D = 7, BOOST_DRAW = [10, 14, 20]
  const arrowSpeed = (t: number) => { let f = t / 20; f = Math.min(1, (f * f + 2 * f) / 3); return 3 * f }
  function arrowBoost(b, sightings) {
    if (process.env.ND_ARROW_BOOST === '0') return
    const team = teamOf(b), inv = o => pos[o.name]?.inv || {}
    const lancerOk = o => Object.entries(inv(o)).some(([n, c]) => /_spear$/.test(n) && Number(c) > 0)
    const archerOk = o => (inv(o).bow || 0) > 0 && (inv(o).arrow || 0) > 0
    for (const e of sightings || []) {
      if (e.visible !== true || !sw.hostile(b, e.id) || !e.position) continue
      const key = `${team}:${e.id}`
      // Только по стоящему или увязшему (паутина, яма): по бегущему за 1–2 с подготовки линия уходит — 0 из 212 в бою 24.10.
      const v = e.velocity; if (!v || Math.hypot(v.x || 0, v.z || 0) > 0.1) continue
      const free = bots.filter(o => teamOf(o) === team && available(o) && !meleeBusy(o) && !sw.panic(o))
      // Один разгон на команду за раз, и по той же цели — только если она сдвинулась с места прошлой попытки (мир изменился):
      // в бою 24.10 попытки шли одна за другой (1 удар из 123), каждая снимала с боя до четырёх своих. Копейщик — сам
      // наблюдатель: «врага не вижу» было в 39 из 123.
      if (boosting.has(team)) continue
      const prev = boostAt.get(key)
      if (prev && distance(prev, e.position) < 2) continue
      const lancer = free.filter(o => o === b && lancerOk(o) && Math.abs(pos[o.name].p.y - e.position.y) < 1.5)
        .map(o => ({ o, d: distance(pos[o.name].p, e.position) })).filter(x => x.d >= 4 && x.d <= 12)
        .sort((x, y) => Math.abs(x.d - BOOST_D) - Math.abs(y.d - BOOST_D))[0]?.o
      if (!lancer) continue
      const L = pos[lancer.name].p
      const archers = free.filter(o => o !== lancer && archerOk(o) && distance(pos[o.name].p, L) <= 14)
        .sort((x, y) => distance(pos[x.name].p, L) - distance(pos[y.name].p, L)).slice(0, 3)
      if (!archers.length) continue
      boostAt.set(key, { ...e.position }); boosting.add(team)
      // Линия: от врага через копейщика; копейщик — в 7 бл., лучники — в 3 и 4.5 бл. за ним (двое рядом, на 0.6 вбок).
      let ux = L.x - e.position.x, uz = L.z - e.position.z
      const n = Math.hypot(ux, uz) || 1; ux /= n; uz /= n
      const at = (k: number, side = 0) => ({ x: e.position.x + ux * k - uz * side, y: L.y, z: e.position.z + uz * k + ux * side })
      const S = at(BOOST_D), spots = [at(BOOST_D + 3, -.6), at(BOOST_D + 3, .6), at(BOOST_D + 4.5)]
      const round = sw.generation, crew = [lancer, ...archers], tokens = crew.map(o => { const t = {}; o.swarmReserved = t; return t })
      const current = () => round === sw.generation && crew.every((o, k) => o.swarmReserved === tokens[k] && alive(o.name) && pos[o.name]?.p && !o.webRescue && !protectedAction(o))
      log(`🏹➶ ${team} разгон стрелой на ${e.id}: копьё ${lancer.name} (${distance(L, e.position).toFixed(0)} бл.), лучники ${archers.map(o => o.name).join(', ')}`)
      void (async () => {
        await Promise.all([sw.go(lancer, S, 1, 4), ...archers.map((o, k) => sw.go(o, spots[k], 1, 4))]).catch(() => {})
        if (!current()) return
        if (!alive(lancer.name) || !pos[lancer.name]?.p || distance(pos[lancer.name].p, S) > 2) { log(`🏹➶ ${lancer.name}: до места не дошёл`); return }
        const lance = lancer.c.call('boost_lance', { foe: e.id, from: archers.map(o => o.name), maxMs: 4500 }).catch(err => ({ detail: { why: err.message } }))
        await new Promise(r => setTimeout(r, 900)) // копьё: задержка до 0.75 с (деревянное) и запас
        if (!current()) { await lance; return }
        const flight = archers.map((o, k) => Math.ceil(distance(pos[o.name]?.p || spots[k], S) / arrowSpeed(BOOST_DRAW[k])))
        const longest = Math.max(...flight)
        const shots = await Promise.all(archers.map((o, k) => o.c.call('boost_shot', { ally: lancer.name, foe: e.id, draw: BOOST_DRAW[k], lag: longest - flight[k], wait: BOOST_DRAW[archers.length - 1] - BOOST_DRAW[k] }).catch(err => ({ detail: { why: err.message } }))))
        const r = await lance, d = r?.detail || r || {}
        log(`🏹➶ ${lancer.name} → ${e.id}: ${d.hit ? 'удар копьём' : 'без удара' + (d.why ? ' — ' + d.why : '')}, скорость ${d.vmax ?? '?'} бл/т; стрелы: ${shots.map((s: any) => { const x = s?.detail || s || {}; return x.ok ? (x.hit ? 'попал' : 'мимо') : x.why || '?' }).join(', ')}`)
      })().finally(() => { boosting.delete(team); crew.forEach((o, k) => { if (o.swarmReserved === tokens[k]) delete o.swarmReserved }) })
    }
  }
  // Испытание (ARMS_PEARL_UP=1; пользователь 24.10: «пусть некоторые боты тестово кидают жемчуг тупо вверх, чтобы проверить,
  // что всё работает»): бот, видящий врага в 8–24 бл. и не в рукопашной, кидает жемчуг вверх с места и убегает — враг должен
  // встретить его засадой, ловушкой или подкопом (🟣 у них в журнале). На команду — один испытатель за раз.
  const pearlTesting = new Set<string>()
  function pearlUpTest(b, sightings) {
    if (process.env.ARMS_PEARL_UP !== '1') return
    const team = teamOf(b), m = pos[b.name]
    if (pearlTesting.has(team) || !available(b) || meleeBusy(b) || sw.panic(b) || !((m?.inv?.ender_pearl || 0) > 0) || (m?.hp ?? 0) < 14) return
    const foe = (sightings || []).find(e => e.visible === true && sw.hostile(b, e.id) && e.position && distance(e.position, m.p) >= 8 && distance(e.position, m.p) <= 24)
    if (!foe) return
    pearlTesting.add(team)
    const token = {}; b.swarmReserved = token
    log(`🧪🟣 ${b.name}: испытание — жемчуг вверх с места (${foe.id} в ${distance(foe.position, m.p).toFixed(0)} бл.)`)
    void b.c.call('pearl_test_up', { runMs: 2500 }).then(r => { const d = r?.detail || r || {}; if (!d.ok) log(`🧪🟣 ${b.name}: не бросил — ${d.why || r?.status}`) })
      .catch(() => {}).finally(() => { pearlTesting.delete(team); if (b.swarmReserved === token) delete b.swarmReserved })
  }
  // Погоня на элитрах за подброшенным (пользователь 25.10: «те, кто на элитрах, подлетают за мной и кидают… преследовали»):
  // враг в воздухе на 8+ над полем — элитровые с зарядами кружат вокруг него (wing_orbit); рефлекс сброса тела (wind-out)
  // бросает на каждом сближении. Летящих за одним — до трёх; дело одно в полёте, повтор — когда он сместился.
  const winging = new Map<string, any>()
  function windWing(b, sightings) {
    const team = teamOf(b)
    for (const e of sightings || []) {
      // windKind has no shot against a glider; leave this fighter to the ordinary air-combat planner.
      if (!e.position || !sw.hostile(b, e.id) || e.gliding === true || e.position.y - arena.y < 8) continue
      // Стоит на гребне у края (ник сквозь уступ — тоже) — заход с центра арены наружу; в воздухе — только видимый.
      const ledge = !e.airborne && (e.visible === true || e.nametag) && edgeRoom(e.position) <= 8
      if (!ledge && (!e.airborne || e.visible === false)) continue
      const wingers = bots.filter(o => teamOf(o) === team && o.last?.m === 'wing_orbit' && o.last.pending !== false && winging.get(o.name)?.foe === e.id)
      // На гребне — один заход и коротко: кружащие втроём по 14 с забирали всех элитровых у тарана копьём (игра пользователя
      // 25.10: «кружат много сверху колизея, а атак копьями мало» — 30 облётов, 2 тарана за 3 мин).
      if (wingers.length >= (ledge ? 1 : 3)) continue
      const kit = o => { const m = pos[o.name], inv = m?.inv || {}; return (inv.elytra || m?.armor?.torso === 'elytra') && (inv.firework_rocket || 0) >= 5 && ((inv.wind_charge || 0) >= 2 || m?.offHand?.item === 'wind_charge') }
      const o = bots.filter(q => teamOf(q) === team && available(q) && !meleeBusy(q) && !sw.panic(q) && kit(q) && !wingers.includes(q) &&
        // Ближе 48 бл. и он у меня в глазах (стенд 25.10: со 140 бл. взлетали и тут же «цели не видно», каждый тик).
        distance(pos[q.name].p, e.position) <= 48 &&
        !(winging.get(q.name)?.round === sw.generation && winging.get(q.name)?.foe === e.id && distance(winging.get(q.name).at, e.position) < 6) &&
        // Не взлетел отсюда (крыша, стена) — снова только с другого места (повтор по месту, не по времени).
        !(winging.get(q.name)?.round === sw.generation && winging.get(q.name)?.failAt && distance(winging.get(q.name).failAt, pos[q.name].p) < 3))
        .sort((x, y) => distance(pos[x.name].p, e.position) - distance(pos[y.name].p, e.position))[0]
      if (!o) continue
      const attempt: any = { foe: e.id, at: { ...e.position }, round: sw.generation }
      winging.set(o.name, attempt)
      log(`🪽🌬 ${o.name} → ${e.id}: ${ledge ? 'на гребне' : 'в воздухе'} +${Math.round(e.position.y - arena.y)} — ${ledge ? 'заход с центра' : 'облёт'} на элитрах, заряды на сближении (${distance(pos[o.name].p, e.position).toFixed(0)} бл.)`)
      // Ход бота полёт не рвёт: резерв до квитанции (guardedTurn пропускает зарезервированного).
      const token = {}; o.swarmReserved = token
      const from = { ...pos[o.name].p }
      void o.c.call('wing_orbit', { target: e.id, seconds: ledge ? 6 : 12, radius: 8, arena, floorY: arena.y, ledge }).then(r => {
        if (sw.generation !== attempt.round || winging.get(o.name) !== attempt) return
        const d = detail(r), latest = sw.boardOf(o).enemies().find(foe => foe.id === e.id)
        // Movement during the reserved flight is already covered; retry only after a later change.
        if (latest?.position) attempt.at = { ...latest.position }
        if (!d.ok && /^взлёт/.test(d.why || '')) attempt.failAt = from
        log(`🪽🌬 ${o.name}: облёт ${d.ok ? `${Math.round((d.ms || 0) / 100) / 10} с, ближе 16 бл. ${d.nearTicks} т., ближе всего ${d.closest} бл., зарядов ${d.windShots ?? '?'}, ${d.why}${d.landed ? ', сел' : ''}` : d.why || r?.status || '?'}`)
      }).catch(() => {})
        .finally(() => { if (o.swarmReserved === token) delete o.swarmReserved })
    }
  }
  return { windObserve, pearlObserve, windFlank, sentries, arrowBoost, pearlUpTest, windWing }
}
