// Рой: ход тела — к точке в арене, лут по пути, исполнение команды, засада кемпера, отпуск тела.
import { WEAPON, distance, cellKey, blockCount } from './common'
import { currentTurn } from './lifecycle'
import type { SwarmDriverCtx } from './common'

export function swarmMoves (sw: SwarmDriverCtx) {
  const { arena, pos, now, log, alive, boxed, boxTries, cooldown, plannedAt, blueprints, placed, boardOf, teamOf } = sw
  // Демон пускает цель похода, только если и сама точка, и центр её клетки с полушириной тела (0.3) лежат в r − 1:
  // прижим к r − 1 давал «outside arena bounds» и повтор каждые 200 мс у края (разбор 13.10) — прижимаем к r − 2.
  const bounded = at => ({ ...at, x: Math.max(arena.x - arena.r + 2, Math.min(arena.x + arena.r - 2, at.x)), z: Math.max(arena.z - arena.r + 2, Math.min(arena.z + arena.r - 2, at.z)) })
  // Лут слабого, а цель ближе к врагу, чем он сам, на 2+ бл. — в журнал с местом вызова (стенд rush 15.10: в 12 из 13 смен
  // «лут → бегство» дистанцию сократил сам лутающий).
  const lootStep = (b, at, tag?) => {
    const me = pos[b.name]?.p
    if (b.swarmTask?.kind !== 'loot' || !me || !at) return
    const foe = boardOf(b).enemies().filter(e => now() - e.seenAt < 3000).sort((a, c) => distance(a.position, me) - distance(c.position, me))[0]
    if (foe && distance(foe.position, at) < distance(foe.position, me) - 2) log(`🧭 ${b.name}: лут к врагу (${tag || String(new Error().stack?.split('\n')[3] || '').trim().replace(/^at (\S+).*?:(\d+):\d+\)?$/, '$1:$2')}): ${Math.round(distance(foe.position, me))} → ${Math.round(distance(foe.position, at))} бл.`)
  }
  // Цель ниже на 4+ (слез с крыши после сундуков наверху) — путь с копкой и блоками (climb): строго по поверхности с крыши вниз
  // не уйти, и бот стоял наверху — «стоит 8 с — goto — сброс» по кругу (галерея 15.10, 31ab).
  const weakLoot = b => !!b.swarmTask?.data?.weak || !Object.keys(pos[b.name]?.inv || {}).some(n => WEAPON.test(n))
  const lootArena = b => {
    const me = pos[b.name]?.p
    if (!me || !weakLoot(b)) return arena
    // Same remembered threats and 22-block clearance as weak chest selection; no hidden positions.
    const { r, foes } = lootThreat(b)
    const avoid = foes.map(e => ({ ...e.position, r: Math.min(r, distance(me, e.position)) }))
    return avoid.length ? { ...arena, avoid } : arena
  }
  // Слабый в задаче лута — любой поход (отход «прочь», поиск, обмен) с той же зоной обхода: отход из комнаты с сундуком
  // через дверь мимо врага давал «лут → бегство» (стенд rush 15.10, 3 из 3 оставшихся).
  // Цена пути, а не запрет по дальности: взлёт/посадка и дефицит ракет против ходьбы и подъёма.
  // shortcut: время полёта оценочное; заменить замерами маршрутов, когда появится телеметрия лут-полётов.
  const travelCost = (b, at) => {
    const m = pos[b.name], rockets = m?.inv?.firework_rocket || 0
    if (!m?.p) return { walk: Infinity, fly: Infinity }
    const d = distance(m.p, at), key = 'lootFly:' + b.name + ':' + cellKey(bounded(at))
    const kit = m.inv?.elytra > 0 || m.armor?.torso === 'elytra'
    const blocks = at.climbFrom === undefined || m.p.y >= at.y - 1 || m.inv?.ender_pearl > 0 ? 0 : Math.max(0, at.y - Math.max(m.p.y, at.climbFrom)) + 3
    return { walk: blockCount(m.inv) >= blocks ? d / 5.6 + Math.max(0, at.y - m.p.y) : Infinity,
      fly: kit && rockets >= 5 && !sw.blocked(b, key, String(rockets)) && sw.lootSafe(b, at) ? 4 + d / 20 + 8 / rockets : Infinity }
  }
  const go = async (b, at, range = 2, seconds = 4, pathArena = b.swarmTask?.kind === 'loot' ? lootArena(b) : arena, air = false) => {
    lootStep(b, at)
    const cost = air ? travelCost(b, at) : { walk: 0, fly: Infinity }, round = sw.generation
    // Полёт не обходит зону угрозы A*: если прямой путь плох, остаётся обычный обход по земле.
    if (air && cost.fly < cost.walk && sw.lootSafe(b, at)) {
      const reply = await b.c.call('fly_to', { at: bounded(at), timeoutSeconds: 15, arena: pathArena }).catch(e => ({ detail: { ok: false, why: e.message } }))
      if (!currentTurn(sw, b, round)) return { status: 'interrupted', detail: { interrupted: true } }
      const state = (await b.c.call('status').catch(() => null))?.state
      if (!currentTurn(sw, b, round)) return { status: 'interrupted', detail: { interrupted: true } }
      if (state?.pos) pos[b.name].p = state.pos
      if (state?.inventory) pos[b.name].inv = state.inventory
      const r = detail(reply)
      log(`🪽 ${b.name}: за лутом/к своему ${cellKey(at)} — ${r.ok ? 'сел' : r.why || reply.status || '?'}`)
      if (reply.status === 'interrupted' || state?.gliding) return { status: 'interrupted', detail: { ...r, interrupted: true } }
      if (!r.ok) sw.failed(b, 'lootFly:' + b.name + ':' + cellKey(bounded(at)), String(pos[b.name]?.inv?.firework_rocket || 0))
      // fly_to садится рядом; под навесом нужен ещё короткий пеший подход, а не ложное «дошёл».
      if (r.ok && state?.pos && distance(state.pos, at) <= range) return { status: 'done', detail: { arrived: state.pos } }
    }
    const down =(pos[b.name]?.p?.y ?? at.y) - at.y > 4
    const up = at.climbFrom !== undefined && at.y - (pos[b.name]?.p?.y ?? at.y) > 1
    return b.c.call('goto', { ...bounded(at), range, timeoutSeconds: up ? 20 : down ? Math.max(seconds, 10) : seconds, arena: pathArena, ...(down || up ? { climb: true } : {}), ...(up ? { exactY: true, _climb: true } : {}), _hunt: true })
  }
  const buildGo = (b, at, range = .25) => b.c.call('goto', { ...at, range, timeoutSeconds: 4, surface: 'strict', arena, _hunt: true })
  const detail = r => r?.detail || r || {}
  const execute = async (b, method, params: any = {}) => {
    let r = await b.c.call(method, params)
    while (r?.status === 'pending' && r.token !== undefined && alive(b.name)) { await new Promise(resolve => setTimeout(resolve, 50)); r = await b.c.call('status', { token: r.token }) }
    return detail(r)
  }
  // Кемпер в коробке (тело: swarm_hold { camp: true }): враг виден — бой; ранен без врага (зелье сквозь стену) — выйти прочь от
  // стрелка и лечиться, засаду 15 с не занимать; дыру без врага тело латает само (Codex 15.10; пользователь: «что будет, если
  // зельями закидать его укрытие — как он спасаться будет»).
  const forgetCamp = b => { const key = `${b.name}:${b.boxedCamp}`; boxed.delete(key); boxTries.delete(key); b.boxedCamp = null; b.boxOutTries = 0 }
  async function reactCamp (b, r) {
    if (!b.boxedCamp) return false
    if (r.patched) log(`🧱 ${b.name}: залатал коробку (${r.patched} бл.)`)
    if (r.camp === 'fight') { log(`🧱 ${b.name}: коробку вскрыли — бью ${r.target}`); await b.c.call('fight', { target: r.target, allowPlayer: true, allowRanged: true, timeoutSeconds: 3, arena }); return true }
    if (r.camp === 'gone') { forgetCamp(b); return false }
    if (r.camp !== 'hurt') return false
    b.campReacting = true
    try {
      const camp = b.boxedCamp, round = sw.generation
      const out = await execute(b, 'box_out', { away: r.away, timeoutSeconds: 24, _climb: true, arena })
      if (round !== sw.generation || !alive(b.name)) return true
      log(`🧱 ${b.name}: урон в коробке ${camp}${r.away ? ' (летело с ' + [r.away.x, r.away.z].map(v => Math.round(v)).join(',') + ')' : ''} — ${out.left ? 'вышел' : out.why || 'не вышел'}`)
      if (!out.left) return true
      forgetCamp(b)
      // Засада раскрыта — закрыта, пока у неё враг (retry.ts siteOpen), а не 15 с.
      sw.siteFailed(b, `camp:${camp}`, (() => { const [x, y, z] = String(camp).split(',').map(Number); return { x, y, z } })())
      plannedAt.delete(teamOf(b))
      delete b.campReacting
      const heal = await execute(b, 'assist', { mode: 'heal', at: out.at })
      if (round !== sw.generation || !alive(b.name)) return true
      if (!heal.ok) {
        const s = await b.c.call('status', {})
        const inv = s?.state?.inventory || pos[b.name]?.inv
        const apple = ['enchanted_golden_apple', 'golden_apple'].find(n => (inv?.[n] || 0) > 0)
        const food = detail(await b.c.call('eat', apple ? { item: apple } : {}))
        log(`🩹 ${b.name}: ${food.ate || food.note || 'поесть не удалось'}`)
      } else log(`🩹 ${b.name}: лечение под ноги`)
      return true
    } finally { delete b.campReacting }
  }
  const release = (b, died = false) => { const board = boardOf(b); if (died && b.swarmDoctrine) board.noteTacticOutcome(b.name, b.swarmDoctrine, false); board.releaseOwner(b.name) }
  const ownProtection = board => [...board.tasks().filter(t => t.kind === 'build').map(t => t.position), ...[...blueprints.entries()].filter(([key]) => key.startsWith(board.team + ':')).flatMap(([, plan]) => plan.protected), ...(placed.get(board.team) || [])]
  const renew = (board, b, claim) => board.renew(claim.id, b.name, claim.claim.token, 25000)
  // Цель лута и прямой путь к ней — не ближе к свежему врагу, чем радиус угрозы (голому и слабому 22, остальным 14), а если
  // бот уже ближе — не ближе, чем он сейчас (стенд rush 15.10: красный стоит, синий ходит маятником 25 → 14 → 25 бл. каждые
  // 5 с — цель за 22 бл. от него, а путь к ней мимо него; Codex 15.10: сундук, куча, подбор и обход выбирали цель каждый
  // по-своему, обход — только по ближнему врагу). Все свежие враги доски, а не один.
  const lootThreat = b => {
    const naked = !Object.keys(pos[b.name]?.inv || {}).some(n => WEAPON.test(n)) || !!b.swarmTask?.data?.weak
    const foes = boardOf(b).enemies().filter(e => now() - e.seenAt < (naked ? 10000 : 3000))
    // Лучник достаёт дальше: у сундука стоишь мишенью (игра пользователя 25.10: o открывал сундук на гребне, лук в 31 бл. — одна стрела, 20 хп).
    return { r: foes.some(e => e.threat === 'bow') ? 34 : naked ? 22 : 14, foes }
  }
  return { bounded, lootStep, weakLoot, lootArena, travelCost, go, buildGo, detail, execute, forgetCamp, reactCamp, release, ownProtection, renew, lootThreat }
}
