// Рой: передачи своим, поиск врага, ветер в паре, позиция (стрельба, стройка, отход), перевес лучника.
import { ownedCount, assessSwarmFight } from '../../../daemon/src/swarm'
import { powerOf } from '../../../daemon/src/pvp/arms-graph'
import { WEAPON, distance, cellKey, withOffHand } from './common'
import { currentTurn } from './lifecycle'
import { antidoteDeliveryValue } from './antidotes'
import type { SwarmDriverCtx } from './common'

// Своё у получателя — с ракетами и зарядами во второй руке (подобранная ракета ложится туда).
const held = (state: any, item: string) => ownedCount({ ...(state || {}), inventory: withOffHand(state?.inventory, state?.offHand) }, item)

export function swarmPosition (sw: SwarmDriverCtx) {
  const { now, bots, pos, arena, log, alive, transfers, telemetry, visited, teamOf, fighting, lootSafe, lootArena, go, renew, detail, execute, buildGo, buildStep, boardOf } = sw
  const panic = (...a: any[]) => sw.panic(...a)
  async function transfer(b, context) {
    const task = (transfers.get(teamOf(b)) || []).find(t => t.assignedTo === b.name && t.status !== 'done')
    const recipient = task && bots.find(o => o.name === task.data.recipient)
    // Неудавшаяся передача — снова, когда пара на новом месте (получатель ушёл с места неудачи), а не через 30 с (21.10).
    if (!task || recipient && sw.blocked(recipient, `transfer:${task.id}`, task.data.item)) return false
    const round = sw.generation
    const antidote = /^(honey_bottle|milk_bucket)$/.test(task.data.item)
    const medical = () => antidoteDeliveryValue(sw, b.name, recipient?.name, task.data.item, context.members, context.board.enemies())
    const coverAt = () => !pos[recipient?.name]?.p ? 0 : recipient.swarmPosition && distance(pos[recipient.name].p, recipient.swarmPosition.at) < 1.5 ? Math.max(0, Math.min(1, recipient.swarmPosition.cover || 0)) :
      recipient.swarmTask?.data?.hide && recipient.swarmTask.position && distance(pos[recipient.name].p, recipient.swarmTask.position) < 3 ? 1 : 0
    // Сидящего в укрытии на шифте можно снабдить; бой, бег и рефлекс опасности не останавливаем.
    const available = () => !!recipient && (!antidote || medical() > 0) && !pos[b.name]?.rescuing && !pos[recipient.name]?.rescuing && currentTurn(sw, b, round) && alive(recipient.name) && !panic(recipient) &&
      !((/^(lava_escape|dodge_blast|clear_web)$/.test(recipient.last?.m || '') || recipient.shieldHold && recipient.last?.m === 'swarm_hold') && recipient.last?.pending !== false) &&
      (medical() > 0 || (!fighting(recipient) || coverAt() > 0 && recipient.last?.m === 'swarm_hold') &&
      context.board.enemies().every(e => now() - e.seenAt >= 1500 || distance(e.position, pos[recipient.name].p) >= 8))
    const meetingScore = () => {
      if (antidote) return medical()
      if (!WEAPON.test(task.data.item) && !/_(helmet|chestplate|leggings|boots)$/.test(task.data.item)) return Infinity
      const m = pos[recipient.name], member = context.members.find(a => a.id === recipient.name)
      if (!member) return -Infinity
      const owned = [...Object.entries(m.inv || {}).map(([name, count]: any) => ({ name, count })), ...Object.values(m.armor || {}).filter(Boolean).map((name: string) => ({ name })), ...(m.enchants || [])]
      const strength = powerOf(owned).total, gain = powerOf([...owned, { name: task.data.item, count: task.data.count }]).total - strength
      const foes = context.board.enemies(), fresh = Math.max(0, ...foes.map(e => 1 - (now() - e.seenAt) / context.board.enemyTtlMs))
      const travel = sw.travelCost(b, m.p), seconds = Math.min(travel.walk, travel.fly)
      const body = { ...member, position: m.p, health: m.hp ?? member.health, inventory: m.inv, armor: m.armor }
      const survival = assessSwarmFight(body, foes, [body]).survivalSeconds
      // Выигрыш слабому против риска ждать: время доставки, живучесть, свежесть врага и доля укрытия.
      return gain / Math.max(1, strength) - fresh * (1 - coverAt()) * seconds / Math.max(.05, survival)
    }
    if (!available() || recipient.swarmReserved) return false
    if (b.swarmTask?.kind === 'loot' && b.swarmTask.data?.weak && !lootSafe(b, pos[recipient.name].p)) return false
    // Аренда покрывает местный поиск укрытия, перелёт и подход; после долгого дела проверяем её снова.
    const claim = context.board.claim(task.id, b.name, 60000)
    if (!claim) return false
    let ok = false, physicalFailure = false
    const reservation = {}
    const releaseRecipient = () => { if (recipient.swarmReserved === reservation) delete recipient.swarmReserved }
    const stopRecipient = async () => {
      if (!available() || recipient.swarmReserved && recipient.swarmReserved !== reservation) return false
      recipient.swarmReserved = reservation
      const paused = await recipient.c.call(antidote ? 'antidote_pause' : 'stop').catch(() => null)
      if (antidote && (!paused || !detail(paused)?.ready)) return false
      for (const until = now() + 3000; recipient.swarmExecuting && now() < until;) await new Promise(resolve => setTimeout(resolve, 50))
      return !recipient.swarmExecuting && available()
    }
    try {
      // Останавливаем начатый поход до полёта: claim держит новые ходы, но не отменяет старый goto.
      if (!await stopRecipient()) return false
      releaseRecipient()
      if (meetingScore() <= 0) {
        const member = context.members.find(m => m.id === recipient.name)
        if (!member) return false
        await positionStep(recipient, { ...context, member }, 'recover')
        if (!available() || meetingScore() <= 0) return false
      }
      // Во время доставки claim держит место, а обычные ходы и рефлексы получателя остаются доступны при угрозе.
      if (!context.board.renew(task.id, b.name, claim.claim.token, 45000)) return false
      const meeting = { ...pos[recipient.name].p }
      if (distance(pos[b.name].p, meeting) > 2.5) {
        const approach = await go(b, meeting, 1.5, 8, lootArena(b), true)
        if (approach?.status === 'interrupted') return false
      }
      if (!available() || distance(pos[recipient.name].p, meeting) > 1.5 || meetingScore() <= 0) return false
      if (!await stopRecipient()) return false
      const fresh = await Promise.all([b.c.call('status'), recipient.c.call('status')])
      if (!currentTurn(sw, b, round) || !alive(recipient.name)) return false
      for (const [i, bot] of [b, recipient].entries()) if (fresh[i]?.state?.pos) pos[bot.name].p = fresh[i].state.pos
      const before = held(fresh[1]?.state, task.data.item)
      const have = fresh[0]?.state?.inventory?.[task.data.item] || 0
      if (have - task.data.reserve < task.data.count || !available()) return false
      // Доска запаздывает за физикой: после посадки доводим бросок по свежим координатам, не расширяем дальность tossTo.
      if (distance(pos[b.name].p, pos[recipient.name].p) > 2.5) {
        const approach = await go(b, pos[recipient.name].p, 1.5, 3, lootArena(b))
        if (approach?.status === 'interrupted') return false
        const state = (await b.c.call('status'))?.state
        if (!currentTurn(sw, b, round) || !alive(recipient.name)) return false
        if (state?.pos) pos[b.name].p = state.pos
      }
      if (!available() || distance(pos[recipient.name].p, meeting) > 1.5) return false
      if (distance(pos[b.name].p, pos[recipient.name].p) > 3) { physicalFailure = true; return false }
      if (!renew(context.board, b, claim)) return false
      const r = detail(await b.c.call('assist', { mode: 'toss', ally: recipient.name, item: task.data.item, count: task.data.count, arena }).catch(e => ({ why: e.message })))
      if (!currentTurn(sw, b, round)) return true
      // Брошено — подобрать в любом случае: начатый бой получателя подождёт 2–3 с, а вещь на земле — потеря (жемчуг донора
      // уже потрачен; DeepSeek, ревью тайников 21.10).
      const pu = r.ok && alive(recipient.name) ? detail(await recipient.c.call('assist', { mode: 'pickup', item: task.data.item, arena }).catch(e => ({ why: e.message }))) : null
      if (!currentTurn(sw, b, round)) return true
      const result = await recipient.c.call('status')
      if (!currentTurn(sw, b, round)) return true
      const received = held(result?.state, task.data.item) - before >= task.data.count
      if (result?.state?.inventory && pos[recipient.name]) pos[recipient.name].inv = withOffHand(result.state.inventory, result.state.offHand)
      if (result?.state?.antidote && pos[recipient.name]) pos[recipient.name].antidote = { ...result.state.antidote, receivedAt: now() }
      if (result?.state?.armor && pos[recipient.name]) pos[recipient.name].armor = result.state.armor
      const donor = await b.c.call('status')
      if (!currentTurn(sw, b, round)) return true
      if (donor?.state?.inventory && pos[b.name]) pos[b.name].inv = withOffHand(donor.state.inventory, donor.state.offHand)
      if (donor?.state?.antidote && pos[b.name]) pos[b.name].antidote = { ...donor.state.antidote, receivedAt: now() }
      if (donor?.state?.armor && pos[b.name]) pos[b.name].armor = donor.state.armor
      if (received && context.board.ack(task.id, b.name, { token: claim.claim.token, confirmed: true })) telemetry.transfers++
      log(`📦 ${b.name} → ${recipient.name}: ${task.data.item}×${task.data.count}, ${received ? 'получено' : 'не подтверждено'}${received ? '' : ` (${r.ok ? `бросил, не подобрал: ${pu?.why || '?'}` : r.why || r.error || '?'})`}`)
      ok = received; physicalFailure = !received
      return true
    } finally {
      // Не вышло (не дошёл, далеко, не подобрал) — пара ждёт нового места (Codex 15.10: 40 отказов «далеко 5.0» за 3 мин).
      if (round === sw.generation) { if (ok) sw.cleared(`transfer:${task.id}`); else if (physicalFailure) sw.failed(recipient, `transfer:${task.id}`, task.data.item) }
      releaseRecipient(); context.board.release(task.id, b.name, claim.claim.token)
    }
  }
  // away — враги, от которых он отходит: обход только в их противоположную полусферу (оторвавшийся «искал» прямо к ним).
  async function search(b, context, away: { position: { x: number; z: number } }[] = []) {
    const team = teamOf(b), marks = visited.get(team) || new Map()
    visited.set(team, marks)
    const m = pos[b.name], index = context.members.findIndex(o => o.id === b.name)
    const candidates = [], behind = []
    for (let k = 0; k < 8; k++) {
      const a = (k + index) * Math.PI / 4, r = 8
      const at = { x: Math.max(arena.x - arena.r + 3, Math.min(arena.x + arena.r - 3, m.p.x + Math.cos(a) * r)), y: m.p.y, z: Math.max(arena.z - arena.r + 3, Math.min(arena.z + arena.r - 3, m.p.z + Math.sin(a) * r)) }
      const key = `${Math.round(at.x / 4)},${Math.round(at.z / 4)}`
      if (distance(at, m.p) < 3 || (b.badSpots || []).some(p => p.from && distance(p.from, m.p) < 2 && distance(p, at) < 1)) continue
      const toward = away.filter(e => (at.x - m.p.x) * (e.position.x - m.p.x) + (at.z - m.p.z) * (e.position.z - m.p.z) > 0).length
      ;(toward ? behind : candidates).push({ at, key, seen: marks.get(key) || 0, toward })
    }
    // Враги с двух сторон — все направления к кому-то: наименее плохое (к меньшему числу), а не стоять (DeepSeek, ревью 21.10).
    const chosen = candidates.sort((a, c) => a.seen - c.seen)[0] ?? behind.sort((a, c) => a.toward - c.toward || a.seen - c.seen)[0]
    if (!chosen) return
    marks.set(chosen.key, now())
    if (marks.size > 256) marks.delete(marks.keys().next().value)
    telemetry.searches++
    await go(b, chosen.at, 2)
  }
  async function pairedWind(b, context, at, attack: { enemy?: string; incomingDps?: number } = {}) {
    const { board } = context, m = pos[b.name], round = sw.generation
    if (m?.rescuing) return false
    const thrower = bots.filter(o => o.name !== b.name && teamOf(o) === teamOf(b) && alive(o.name) && !pos[o.name]?.rescuing && !o.swarmReserved && (pos[o.name]?.inv?.wind_charge || 0) > 0 && distance(pos[o.name].p, m.p) < 5 && !panic(o) &&
      !fighting(o)).sort((a, c) => distance(pos[a.name].p, m.p) - distance(pos[c.name].p, m.p))[0]
    if (!thrower) return false
    const key = `spear-wind:${b.name}`, signature = attack.enemy ? JSON.stringify([attack.enemy, at, thrower.name, pos[thrower.name]?.p, m.inv, m.hp, attack.incomingDps, context.members?.map(a => [a.id, a.position])]) : ''
    if (attack.enemy && sw.blocked?.(b, key, signature)) return false
    const preview = async () => {
      const own = await thrower.c.call('status', { physics: true }), physics = own?.detail?.physics
      if (!currentTurn(sw, b, round) || !alive(thrower.name)) return null
      if (!physics?.onGround) return null
      const report = { id: thrower.name, position: physics.pos, velocity: physics.velocity, onGround: physics.onGround, attributes: physics.attributes }
      const dry = await execute(b, 'wind_receive', { thrower: report, to: at, ...attack, arena, dryRun: true })
      if (!currentTurn(sw, b, round) || !alive(thrower.name)) return null
      if (!dry.plan) { if (attack.enemy && !dry.partial) sw.failed?.(b, key, signature); return null }
      return { report, dry }
    }
    // Combat rejection leaves the idle helper working; navigation keeps its existing exclusive claim throughout planning.
    let prepared = attack.enemy ? await preview() : null
    if (round !== sw.generation || attack.enemy && !prepared || !alive(b.name) || pos[b.name]?.rescuing || pos[thrower.name]?.rescuing || thrower.swarmReserved || fighting(thrower) || !alive(thrower.name)) return false
    const id = `wind-pair:${b.name}`
    board.upsert({ id, kind: 'goto', assignedTo: b.name, participants: [b.name, thrower.name], position: at, expiresAt: now() + 20000 })
    const claim = board.claim(id, b.name, 20000)
    if (!claim) return false
    const reservation = {}
    thrower.swarmReserved = true
    thrower.swarmWindReservation = reservation
    const ownsPair = () => currentTurn(sw, b, round) && alive(thrower.name) && !pos[b.name]?.rescuing && !pos[thrower.name]?.rescuing && !fighting(thrower) && renew(board, b, claim)
    try {
      await thrower.c.call('stop')
      if (!ownsPair()) return false
      const until = now() + 5000
      while (thrower.swarmExecuting && now() < until) await new Promise(resolve => setTimeout(resolve, 50))
      if (thrower.swarmExecuting || !ownsPair()) return false
      if (!prepared) prepared = await preview()
      if (!prepared || !ownsPair()) return false
      const { report, dry } = prepared
      if (!ownsPair()) return false
      const ready = await execute(thrower, 'wind_boost', { ally: b.name, plan: dry.plan, arena, ...(attack.enemy ? { prepareOnly: true } : { dryRun: true }) })
      if (!ready.ok || !ownsPair() || !Number.isFinite(dry.gameTick) || !Number.isFinite(ready.gameTick)) return false
      const startTick = Math.max(dry.gameTick, ready.gameTick) + (dry.plan.spear?.price.setupTicks ?? 40)
      let receive: any, boost: any
      if (attack.enemy) {
        let finished = false, step = 0
        const receiving = execute(b, 'wind_receive', { thrower: report, to: at, ...attack, plan: dry.plan, arena, startTick }).then(r => { finished = true; return r }, error => { finished = true; throw error })
        boost = { ok: false }
        while (!finished && ownsPair()) {
          const progress = detail(await b.c.call('wind_report', { pairProgress: true, startTick, afterStep: step }).catch(() => null))
          if (finished || !ownsPair()) break
          step = Math.max(step, progress?.executed || 0)
          if (!progress?.ok || !progress.plan?.progress) continue
          boost = await execute(thrower, 'wind_boost', { ally: b.name, plan: progress.plan, arena, startTick })
          if (boost.fired) break
        }
        receive = await receiving
      } else [receive, boost] = await Promise.all([
          execute(b, 'wind_receive', { thrower: report, to: at, ...attack, plan: dry.plan, arena, startTick }),
          execute(thrower, 'wind_boost', { ally: b.name, plan: dry.plan, arena, startTick })
        ])
      if (!ownsPair()) return false
      const ok = !!receive.ok && !!boost.ok && (!attack.enemy || !!receive.combat?.hit && !!receive.received && !!boost.launchConfirmed)
      board.ack(id, b.name, { token: claim.claim.token, confirmed: ok })
      if (ok && attack.enemy) sw.cleared?.(key)
      if (ok) log(attack.enemy ? `🌬 ${thrower.name} разогнал копьё ${b.name} → ${attack.enemy}: попадание подтверждено` : `🌬 ${thrower.name} подбросил ${b.name} на ${cellKey(at)}`)
      return ok ? receive : false
    } finally {
      if (thrower.swarmWindReservation === reservation) { delete thrower.swarmWindReservation; if (thrower.swarmReserved === true) delete thrower.swarmReserved }
      if (round === sw.generation) { board.release(id, b.name, claim.claim.token); board.cancel(id) }
    }
  }
  // Запрос позиции — по миру, а не раз в 20 с (21.10): занятая позиция держится, пока бот на ней, цель та же и враги те же;
  // неудача — до ухода бота с места или смены врагов (retry.ts). Не больше двух тяжёлых запросов разом — бюджет ЦП.
  async function positionStep(b, context, purpose) {
    const scene = `${purpose}:${context.board.enemies().map(e => e.id).sort().join(',')}`, me = pos[b.name]?.p
    const holding = !!me && b.swarmPosition?.purpose === purpose && b.swarmPosition.scene === scene && distance(me, b.swarmPosition.at) < 1.5
    if (sw.positionQueries >= 2 || holding || sw.blocked(b, `position:${b.name}`, scene)) return false
    sw.failed(b, `position:${b.name}`, scene)
    sw.positionQueries++; b.swarmBusyUntil = now() + 20000
    const round = sw.generation
    try {
      const m = pos[b.name], board = context.board
      const query = await execute(b, 'swarm_position', { purpose, arena, enemies: board.enemies().map(e => ({ id: e.id })), radius: 12, limit: 6, reserve: context.member.reserve, budgetMs: 1500 })
      if (!currentTurn(sw, b, round)) return false
      const candidates = query.observed ? query.candidates || [] : []
      // Место, куда не вышло, — плохое, пока бот там же, откуда пробовал (сторож арены так же: watch.ts).
      for (const choice of candidates.filter(c => c.score > 0 && distance(c.at, m.p) > 2 && !(b.badSpots || []).some(p => p.from && distance(p.from, m.p) < 2 && distance(p, c.at) < 1))) {
        const method = [...choice.methods].sort((a, c) => a.cost - c.cost)[0]
        if (!method) continue
        let ok = false, actual
        if (method.kind === 'build' && method.plan?.kind === 'pillar') {
          const id = `pillar:${b.name}`, base = { x: Math.floor(m.p.x), y: Math.floor(m.p.y), z: Math.floor(m.p.z) }
          board.upsert({ id, kind: 'build', assignedTo: b.name, position: base, data: { block: method.params.item }, expiresAt: now() + 15000 })
          const claim = board.claim(id, b.name, 15000)
          if (!claim) continue
          try {
            const r = await execute(b, 'swarm_pillar', { ...method.params, arena, allies: context.members.map(a => a.id), timeoutSeconds: 12 })
            if (!currentTurn(sw, b, round)) return false
            ok = r.ok === true && r.at && distance(r.at, choice.at) < .6
            actual = r.at
            board.ack(id, b.name, { token: claim.claim.token, confirmed: ok, position: base, block: method.params.item })
          } finally { if (round === sw.generation) { board.release(id, b.name, claim.claim.token); board.cancel(id) } }
        } else if (method.kind === 'build') {
          const approach = await buildGo(b, method.plan.approach)
          if (!currentTurn(sw, b, round)) return false
          if (approach?.status === 'failed') continue
          const cell = method.plan.cells[0]
          await buildStep(b, context, { kind: 'platform', id: `platform:${cellKey(cell.at)}`, origin: cell.at, cells: method.plan.cells, protected: [method.plan.reference] })
          if (!currentTurn(sw, b, round)) return false
          if (!board.tasks().some(t => t.kind === 'build' && cellKey(t.position) === cellKey(cell.at) && t.status === 'done')) return true
          const moved = await buildGo(b, choice.at)
          actual = detail(moved).arrived
          ok = !!actual && distance(actual, choice.at) < .6
        } else {
          if (method.kind !== 'walk') { const pair = await pairedWind(b, context, choice.at); ok = !!pair; actual = pair && pair.at }
          if (!currentTurn(sw, b, round)) return false
          if (!ok && choice.at.y < m.p.y && m.p.y - choice.at.y <= 4 && Math.hypot(choice.at.x - m.p.x, choice.at.z - m.p.z) <= 3) {
            const ledge = await execute(b, 'ledge_to', { at: choice.at, arena, maxFallDamage: 0, timeoutSeconds: 5 })
            if (!currentTurn(sw, b, round)) return false
            ok = !!ledge.ok
            actual = ledge.at
          }
          if (!ok) {
            const r = await execute(b, method.skill, { ...method.params, arena, ...(method.kind === 'walk' ? { range: .25, surface: 'strict', timeoutSeconds: 6, _hunt: true } : {}) })
            ok = r.ok === true || r.reached === true || !!r.arrived && distance(r.arrived, choice.at) < .6
            actual = r.at || r.arrived
          }
        }
        if (!currentTurn(sw, b, round)) return false
        if (ok && (!actual || ![actual.x, actual.y, actual.z].every(Number.isFinite))) {
          const s = await b.c.call('status', { physics: true }); actual = s?.state?.pos || s?.detail?.physics?.pos
          if (!currentTurn(sw, b, round)) return false
          ok = !!actual && distance(actual, choice.at) < .6
        }
        if (!ok) { (b.badSpots ||= []).push({ ...choice.at, from: { ...m.p } }); b.badSpots = b.badSpots.slice(-32); continue }
        b.swarmPosition = { ...choice, purpose, scene, placedAt: now() }
        m.p = { ...actual }
        sw.cleared(`position:${b.name}`)
        board.recordFact(b.name, now(), { id: `rally:${b.name}`, kind: 'mark', position: choice.at }, 30000)
        log(`🏔 ${b.name}: ${purpose} → ${cellKey(choice.at)} (${method.kind})`)
        return true
      }
      return false
    } finally { sw.positionQueries--; if (round === sw.generation) delete b.swarmBusyUntil }
  }
  const rangedAdvantage = b => {
    const here = b.swarmPosition, m = pos[b.name], enemies = boardOf(b).enemies()
    return !!here && here.purpose === 'ranged' && m?.inv?.bow && (m.attackArrows ?? (m.inv.arrow || 0) + (m.inv.spectral_arrow || 0)) && distance(m.p, here.at) < 1 && enemies.length && enemies.every(e => now() - e.seenAt < 1000 && e.position.y + 6 < m.p.y && !['bow', 'aerial', 'blast'].includes(e.threat) && !/bow|trident|end_crystal|respawn_anchor/.test(e.equipment?.weapon || ''))
  }
  return { transfer, search, pairedWind, positionStep, rangedAdvantage }
}
