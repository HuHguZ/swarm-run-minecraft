// Рой: передачи своим, поиск врага, ветер в паре, позиция (стрельба, стройка, отход), перевес лучника.
import { ownedCount } from '../../../daemon/src/swarm'
import { distance, cellKey } from './common'
import type { SwarmDriverCtx } from './common'

export function swarmPosition (sw: SwarmDriverCtx) {
  const { now, bots, pos, arena, log, alive, transfers, cooldown, telemetry, visited, teamOf, fighting, lootSafe, go, renew, detail, execute, buildGo, buildStep, boardOf } = sw
  const panic = (...a: any[]) => sw.panic(...a)
  async function transfer(b, context) {
    const task = (transfers.get(teamOf(b)) || []).find(t => t.assignedTo === b.name && t.status !== 'done')
    if (!task || (cooldown.get(task.id) || 0) > now()) return false
    const recipient = bots.find(o => o.name === task.data.recipient)
    // Получатель в бою или бегстве — не выдёргивать его подбором (ревью 13.10): обмен подождёт.
    if (!recipient || fighting(recipient)) return false
    if (recipient.swarmReserved) return false
    if (b.swarmTask?.kind === 'loot' && b.swarmTask.data?.weak && pos[recipient.name]?.p && !lootSafe(b, pos[recipient.name].p)) return false
    const claim = context.board.claim(task.id, b.name, 15000)
    if (!claim) return false
    let ok = false
    // Получатель стоит, пока донор подходит и бросает (как напарник парного ветра): он уходил по своему делу, и бросок
    // был «далеко» или мимо — передач подтверждено 3 из 121 (соло-арена 14.10).
    try {
      if (distance(pos[b.name].p, pos[recipient.name].p) > 2.5) await go(b, pos[recipient.name].p, 1.5)
      // Бросок — только с 3 бл. (tossTo): дальше получателя не останавливать (Codex 15.10: 36 отказов «далеко 5.0»).
      if (distance(pos[b.name].p, pos[recipient.name].p) > 3) return false
      if (fighting(recipient)) return false
      recipient.swarmReserved = true
      await recipient.c.call('stop').catch(() => {})
      for (const until = now() + 3000; recipient.swarmExecuting && now() < until;) await new Promise(resolve => setTimeout(resolve, 50))
      if (recipient.swarmExecuting) return false
      const fresh = await Promise.all([b.c.call('status'), recipient.c.call('status')])
      const before = ownedCount(fresh[1]?.state || {}, task.data.item)
      const have = fresh[0]?.state?.inventory?.[task.data.item] || 0
      if (have - task.data.reserve < task.data.count) return false
      if (distance(pos[b.name].p, pos[recipient.name].p) > 3) return false
      if (!renew(context.board, b, claim)) return false
      const r = detail(await b.c.call('assist', { mode: 'toss', ally: recipient.name, item: task.data.item, count: task.data.count, arena }))
      const pu = r.ok && !fighting(recipient) ? detail(await recipient.c.call('assist', { mode: 'pickup', item: task.data.item, arena }).catch(e => ({ why: e.message }))) : null
      const result = await recipient.c.call('status')
      const received = ownedCount(result?.state || {}, task.data.item) - before >= task.data.count
      if (result?.state?.inventory && pos[recipient.name]) pos[recipient.name].inv = result.state.inventory
      if (result?.state?.armor && pos[recipient.name]) pos[recipient.name].armor = result.state.armor
      const donor = await b.c.call('status')
      if (donor?.state?.inventory && pos[b.name]) pos[b.name].inv = donor.state.inventory
      if (donor?.state?.armor && pos[b.name]) pos[b.name].armor = donor.state.armor
      if (received && context.board.ack(task.id, b.name, { token: claim.claim.token, confirmed: true })) telemetry.transfers++
      log(`📦 ${b.name} → ${recipient.name}: ${task.data.item}×${task.data.count}, ${received ? 'получено' : 'не подтверждено'}${received ? '' : ` (${r.ok ? `бросил, не подобрал: ${pu?.why || '?'}` : r.why || r.error || '?'})`}`)
      ok = received
      return true
    } finally {
      // Не вышло (не дошёл, далеко, не подобрал) — эта пара 30 с отдыхает (Codex 15.10: 40 отказов «далеко 5.0» за 3 мин).
      cooldown.set(task.id, now() + (ok ? 4000 : 30000))
      delete recipient.swarmReserved; context.board.release(task.id, b.name, claim.claim.token)
    }
  }
  async function search(b, context) {
    const team = teamOf(b), marks = visited.get(team) || new Map()
    visited.set(team, marks)
    const m = pos[b.name], index = context.members.findIndex(o => o.id === b.name)
    const candidates = []
    for (let k = 0; k < 8; k++) {
      const a = (k + index) * Math.PI / 4, r = 8
      const at = { x: Math.max(arena.x - arena.r + 3, Math.min(arena.x + arena.r - 3, m.p.x + Math.cos(a) * r)), y: m.p.y, z: Math.max(arena.z - arena.r + 3, Math.min(arena.z + arena.r - 3, m.p.z + Math.sin(a) * r)) }
      const key = `${Math.round(at.x / 4)},${Math.round(at.z / 4)}`
      if (distance(at, m.p) < 3) continue
      candidates.push({ at, key, seen: marks.get(key) || 0 })
    }
    const chosen = candidates.sort((a, c) => a.seen - c.seen)[0]
    if (!chosen) return
    marks.set(chosen.key, now())
    if (marks.size > 256) marks.delete(marks.keys().next().value)
    telemetry.searches++
    await go(b, chosen.at, 2)
  }
  async function pairedWind(b, context, at) {
    const { board } = context, m = pos[b.name]
    const thrower = bots.filter(o => o.name !== b.name && teamOf(o) === teamOf(b) && alive(o.name) && !o.swarmReserved && (pos[o.name]?.inv?.wind_charge || 0) > 0 && distance(pos[o.name].p, m.p) < 5 && !panic(o) &&
      !fighting(o)).sort((a, c) => distance(pos[a.name].p, m.p) - distance(pos[c.name].p, m.p))[0]
    if (!thrower) return false
    const id = `wind-pair:${b.name}`
    board.upsert({ id, kind: 'goto', assignedTo: b.name, participants: [b.name, thrower.name], position: at, expiresAt: now() + 20000 })
    const claim = board.claim(id, b.name, 20000)
    if (!claim) return false
    thrower.swarmReserved = true
    try {
      await thrower.c.call('stop')
      const until = now() + 5000
      while (thrower.swarmExecuting && now() < until) await new Promise(resolve => setTimeout(resolve, 50))
      if (thrower.swarmExecuting || !renew(board, b, claim)) return false
      const own = await thrower.c.call('status', { physics: true }), physics = own?.detail?.physics
      if (!physics?.onGround) return false
      const report = { id: thrower.name, position: physics.pos, velocity: physics.velocity, onGround: physics.onGround, attributes: physics.attributes }
      const dry = await execute(b, 'wind_receive', { thrower: report, to: at, arena, dryRun: true })
      if (!dry.plan || fighting(thrower) || !renew(board, b, claim)) return false
      const ready = await execute(thrower, 'wind_boost', { ally: b.name, plan: dry.plan, arena, dryRun: true })
      if (!ready.ok || fighting(thrower) || !Number.isFinite(dry.gameTick) || !Number.isFinite(ready.gameTick)) return false
      const startTick = Math.max(dry.gameTick, ready.gameTick) + 40
      const [receive, boost] = await Promise.all([
        execute(b, 'wind_receive', { thrower: report, to: at, plan: dry.plan, arena, startTick }),
        execute(thrower, 'wind_boost', { ally: b.name, plan: dry.plan, arena, startTick })
      ])
      const ok = !!receive.ok && !!boost.ok
      board.ack(id, b.name, { token: claim.claim.token, confirmed: ok })
      if (ok) log(`🌬 ${thrower.name} подбросил ${b.name} на ${cellKey(at)}`)
      return ok ? receive : false
    } finally { delete thrower.swarmReserved; board.release(id, b.name, claim.claim.token); board.cancel(id) }
  }
  async function positionStep(b, context, purpose) {
    if (sw.positionQueries >= 2 || (cooldown.get(`position:${b.name}`) || 0) > now()) return false
    cooldown.set(`position:${b.name}`, now() + 20000)
    sw.positionQueries++; b.swarmBusyUntil = now() + 20000
    const round = sw.generation
    try {
      const m = pos[b.name], board = context.board
      const query = await execute(b, 'swarm_position', { purpose, arena, enemies: board.enemies().map(e => ({ id: e.id })), radius: 12, limit: 6, reserve: context.member.reserve, budgetMs: 1500 })
      if (round !== sw.generation || !alive(b.name)) return false
      const candidates = query.observed ? query.candidates || [] : []
      for (const choice of candidates.filter(c => c.score > 0 && distance(c.at, m.p) > 2 && !(b.badSpots || []).some(p => p.until > now() && distance(p, c.at) < 1))) {
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
            ok = r.ok === true && r.at && distance(r.at, choice.at) < .6
            actual = r.at
            board.ack(id, b.name, { token: claim.claim.token, confirmed: ok, position: base, block: method.params.item })
          } finally { board.release(id, b.name, claim.claim.token); board.cancel(id) }
        } else if (method.kind === 'build') {
          const approach = await buildGo(b, method.plan.approach)
          if (approach?.status === 'failed') continue
          const cell = method.plan.cells[0]
          await buildStep(b, context, { kind: 'platform', id: `platform:${cellKey(cell.at)}`, origin: cell.at, cells: method.plan.cells, protected: [method.plan.reference] })
          if (!board.tasks().some(t => t.kind === 'build' && cellKey(t.position) === cellKey(cell.at) && t.status === 'done')) return true
          const moved = await buildGo(b, choice.at)
          actual = detail(moved).arrived
          ok = !!actual && distance(actual, choice.at) < .6
        } else {
          if (method.kind !== 'walk') { const pair = await pairedWind(b, context, choice.at); ok = !!pair; actual = pair && pair.at }
          if (!ok && choice.at.y < m.p.y && m.p.y - choice.at.y <= 4 && Math.hypot(choice.at.x - m.p.x, choice.at.z - m.p.z) <= 3) {
            const ledge = await execute(b, 'ledge_to', { at: choice.at, arena, maxFallDamage: 0, timeoutSeconds: 5 })
            ok = !!ledge.ok
            actual = ledge.at
          }
          if (!ok) {
            const r = await execute(b, method.skill, { ...method.params, arena, ...(method.kind === 'walk' ? { range: .25, surface: 'strict', timeoutSeconds: 6, _hunt: true } : {}) })
            ok = r.ok === true || r.reached === true || !!r.arrived && distance(r.arrived, choice.at) < .6
            actual = r.at || r.arrived
          }
        }
        if (round !== sw.generation || !alive(b.name)) return false
        if (ok && (!actual || ![actual.x, actual.y, actual.z].every(Number.isFinite))) {
          const s = await b.c.call('status', { physics: true }); actual = s?.state?.pos || s?.detail?.physics?.pos
          ok = !!actual && distance(actual, choice.at) < .6
        }
        if (!ok) { (b.badSpots ||= []).push({ ...choice.at, until: now() + 15000 }); b.badSpots = b.badSpots.filter(p => p.until > now()).slice(-32); continue }
        b.swarmPosition = { ...choice, purpose, placedAt: now() }
        m.p = { ...actual }
        b.swarmHoldUntil = now() + 5000
        board.recordFact(b.name, now(), { id: `rally:${b.name}`, kind: 'mark', position: choice.at }, 30000)
        log(`🏔 ${b.name}: ${purpose} → ${cellKey(choice.at)} (${method.kind})`)
        return true
      }
      return false
    } finally { sw.positionQueries--; delete b.swarmBusyUntil }
  }
  const rangedAdvantage = b => {
    const here = b.swarmPosition, m = pos[b.name], enemies = boardOf(b).enemies()
    return !!here && here.purpose === 'ranged' && m?.inv?.bow && m.inv.arrow && distance(m.p, here.at) < 1 && enemies.length && enemies.every(e => now() - e.seenAt < 1000 && e.position.y + 6 < m.p.y && !['bow', 'aerial', 'blast'].includes(e.threat) && !/bow|trident|end_crystal|respawn_anchor/.test(e.equipment?.weapon || ''))
  }
  return { transfer, search, pairedWind, positionStep, rangedAdvantage }
}
