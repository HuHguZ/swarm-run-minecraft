// Рой: стройка по чертежу, копка вверх к врагу, динамит.
import { type BlueprintCell, addBlueprint, nextBuild } from '../../../daemon/src/swarm'
import { swarmBlueprint, masonry, BREACH_FRESH_MS, AIR, DIRECTIONS } from '../../../daemon/src/swarm-work'
import { placementRank } from '../../../daemon/src/swarm-senses'
import { randomUUID } from 'node:crypto'
import { FACES } from '../../../daemon/src/build'
import { BLOCK, blockCount, buildStock, distance, cellKey } from './common'
import { currentTurn } from './lifecycle'
import { fitOutpost, outpostSurvey } from './outpost'
import { climbOutpost } from './outpost-step'
import type { SwarmDriverCtx } from './common'
import type { SwarmPosition, SwarmTask } from '../../../daemon/src/swarm/types'

export function swarmBuild (sw: SwarmDriverCtx) {
  const { now, pos, home, arena, log, bots, alive, cooldown, blueprints, telemetry, placed, detail, say, renew, buildGo, teamOf, ownProtection, boardOf, say2, go } = sw
  type FaceFailure = { from: SwarmPosition; stock: string; faces: string; waiting?: string[] }
  const failedFaces = new WeakMap<object, Map<string, Map<string, FaceFailure>>>()
  const accessSteps = new WeakMap<object, SwarmPosition>()
  const pendingSteps = new Set<string>()
  const exposedWorkers = new WeakMap<object, { round: number; checkedTurn?: object; contained?: string }>()
  type Opening = { at: SwarmPosition; exit: SwarmPosition; name: string }
  const doors = new WeakMap<object, { cells: SwarmPosition[]; exit: SwarmPosition; workers: Map<string, { seenAir: Set<string>; next: number }> }>()
  const rememberExposure = (b, result, round) => {
    if (result.aborted && result.why === 'direct_threat' && result.retreat?.clear === false) exposedWorkers.set(b, { round })
  }
  async function safeToResume(b, members, contained: string[] = []) {
    const exposed = exposedWorkers.get(b), round = sw.generation
    if (exposed.round !== round) { exposedWorkers.delete(b); return true }
    const owner = b.swarmTurnOwner, key = contained.join(',')
    if (owner && owner === exposed.checkedTurn && key === exposed.contained) return false
    const sight = await b.c.call('swarm_pose', { placementSafety: true, allies: members.map(a => a.id), contained }).catch(() => null)
    if (!currentTurn(sw, b, round) || owner !== b.swarmTurnOwner) return false
    if (sight?.notStarted || sight?.status && sight.status !== 'done' || detail(sight)?.safeToResume !== true) {
      exposed.checkedTurn = owner; exposed.contained = key
      return false
    }
    exposedWorkers.delete(b)
    return true
  }
  // placed holds each team's current round only. A replacement gets its own receipt even at the same coordinates.
  const match = randomUUID()
  const repairReceipts = new WeakMap<SwarmPosition, { id: string; token: number }>()
  function observeBreaches(b, reports, asked: number) {
    const delay = now() - asked
    if (!alive(b.name) || !Number.isFinite(delay) || delay < 0 || delay >= BREACH_FRESH_MS) return
    const board = boardOf(b), own = placed.get(board.team)
    if (!own?.size) return
    for (const r of reports) {
      if (!r?.at || !Number.isFinite(r.ageMs) || r.ageMs < 0 || r.ageMs + delay >= BREACH_FRESH_MS) continue
      const key = cellKey(r.at), proof = repairReceipts.get(own.get(key))
      if (!proof || r.repair?.match !== match + '/' + board.team || proof.token !== r.repair.token) continue
      const task = board.tasks().find(t => t.id === proof.id)
      if (task?.status !== 'done' || !blueprints.has(board.team + ':' + task.data.blueprint)) continue
      const { doneAt, ...work } = task
      board.cancel(task.id); board.upsert({ ...work, priority: Math.max(task.priority || 60, 75) })
      own.delete(key)
      log(`🧱 ${b.name}: видит пролом ${task.id}, ремонт открыт`)
    }
  }
  async function buildStep(b, context, request: any = {}, supportCells?: Set<string>) {
    // Пауза после отказа клетки — для всех путей стройки (31ao, выступ 15.10: «не к чему прислонить» 13 раз за 25 с по задаче build).
    const stockAtStart = buildStock(pos[b.name]?.inv)
    if (sw.blocked(b, `work:${b.name}`, stockAtStart)) return false
    const { board, member } = context, m = pos[b.name], generation = sw.generation
    let item = Object.keys(m.inv || {}).find(n => BLOCK.test(n) && m.inv[n] > 0)
    if (!item && request.kind !== 'outpost') return false
    if (exposedWorkers.has(b) && !await safeToResume(b, context.members, request.contained)) return false
    const start = request.origin || home(b), kind = request.kind || 'shelter'
    const fitDeck = kind === 'outpost' && !request.cells
    const at = { x: Math.floor(start.x), y: fitDeck ? Math.ceil(start.y - 1e-6) : Math.floor(start.y), z: Math.floor(start.z) }
    const teamPrefix = board.team + ':'
    const site = teamPrefix + (request.id || (kind === 'shelter' ? 'shelter' : `${kind}:${cellKey(at)}`))
    const projectAtSite = () => {
      let shared: string | undefined
      if (fitDeck && !request.id && !blueprints.has(site)) for (const [key, plan] of blueprints) {
        if (plan.kind !== 'outpost' || !key.startsWith(teamPrefix)) continue
        const p = plan.origin
        if (Math.abs(p.x - at.x) <= 1 && Math.abs(p.z - at.z) <= 1 && at.y >= p.y - 1 && at.y <= p.y) return key
        // A worker on a lower placement stance can still work the same wall. A second room here would overlap it.
        if (!shared && Math.abs(p.x - at.x) <= 2 && Math.abs(p.z - at.z) <= 2 &&
            plan.cells.some(({ at: c }) => Math.abs(c.x - at.x) <= 1 && Math.abs(c.z - at.z) <= 1 && c.y >= at.y - 1 && c.y <= at.y + 2)) shared = key
      }
      return shared || site
    }
    let project = projectAtSite(), seenLayout
    if (!item) return !request.fromHere && clearPassage(b, context, project)
    let direction = request.direction || 'north'
    if (fitDeck && !blueprints.has(project)) {
      const owner = b.swarmTurnOwner
      const reply = await b.c.call('swarm_pose', { inspectOnly: true, outpost: true, cells: outpostSurvey(at) }).catch(() => null)
      if (!currentTurn(sw, b, generation) || owner !== b.swarmTurnOwner || !reply || reply.notStarted || reply.status && reply.status !== 'done') return false
      seenLayout = detail(reply)?.cells || []
      project = projectAtSite()
      if (!blueprints.has(project)) {
        const deck = fitOutpost(at, seenLayout, arena, request.direction)
        if (!deck) return false
        at.y = deck.y; direction = deck.direction
      }
    }
    const id = project.slice(teamPrefix.length)
    if (!blueprints.has(project)) {
      // Кокон и отсечка — на одну цель: новое место (цель ушла) отменяет старую стройку того же вида, иначе её клетки
      // держат доску до истечения и новый чертёж отклоняется как пересекающийся.
      if (kind === 'cocoon' || kind === 'cutoff') for (const [key, old] of [...blueprints]) if (key.startsWith(board.team + ':') && old.kind === kind) {
        for (const t of board.tasks().filter(t => t.kind === 'build' && t.data?.blueprint === key.slice(board.team.length + 1))) board.cancel(t.id)
        blueprints.delete(key)
      }
      const blueprint: ReturnType<typeof swarmBlueprint> & { material?: string; expiresAt?: number } = request.cells ? { kind, origin: at, cells: request.cells, protected: request.protected || [] } : swarmBlueprint(kind, at, direction)
      if (arena && blueprint.cells.some(c => Math.abs(c.at.x + .5 - arena.x) + .3 >= arena.r || Math.abs(c.at.z + .5 - arena.z) + .3 >= arena.r || c.at.y <= (arena.killY ?? -64))) return false
      const total = new Map<string, number>()
      for (const own of context.members) for (const [name, count] of Object.entries(own.inventory) as [string, number][]) if (BLOCK.test(name)) total.set(name, (total.get(name) || 0) + count)
      item = [...total].sort((a, c) => c[1] - a[1])[0]?.[0] || item
      blueprint.material = item
      if (kind === 'cocoon' || kind === 'cutoff') blueprint.expiresAt = now() + 30000
      const cells = blueprint.cells.map((c): BlueprintCell => ({ id: cellKey(c.at), position: c.at, block: item }))
      const floorY = Math.min(...cells.map(c => c.position.y))
      const supported = new Set(cells.filter(c => c.position.y === floorY).map(c => c.id))
      while (supported.size < cells.length) {
        const c = cells.find(c => !supported.has(c.id) && cells.some(o => supported.has(o.id) && distance(o.position, c.position) === 1))
        if (!c) throw new Error('Blueprint has an unsupported component')
        const support = cells.find(o => supported.has(o.id) && distance(o.position, c.position) === 1)
        c.dependsOn = [support.id]; supported.add(c.id)
      }
      // Closing the roof early removes the jumping viewpoints needed for the far walls.
      const walls = cells.filter(c => c.position.y < at.y + 2).map(c => c.id)
      for (const c of cells.filter(c => c.position.y === at.y + 2)) c.dependsOn = [...new Set([...(c.dependsOn || []), ...walls])]
      // Кокон: ряд крыши над щелью — первым после стен. Щель и пустая клетка над ней — проём в два блока: на стенку под
      // щелью запрыгивают и выходят (лаборатория 13.10: цель ушла так, пока крыша над щелью ждала очереди 5 с).
      if (kind === 'cocoon') for (const slit of (blueprint.protected || []).filter(p => p.y === at.y + 1 && (Math.abs(p.x - at.x) === 1) !== (Math.abs(p.z - at.z) === 1)))
        for (const c of cells) if (c.position.y === at.y + 2 && (slit.x !== at.x ? c.position.x === slit.x : c.position.z === slit.z)) (c as any).priority = 75
      const passage = plan => plan.kind === 'outpost' ? plan.protected.filter(p => p.y >= plan.origin.y && p.y <= plan.origin.y + 1) : []
      const planned = new Set(cells.map(c => c.id)), keepClear = new Set(passage(blueprint).map(cellKey))
      if (board.tasks().some(t => t.kind === 'build' && (planned.has(cellKey(t.position)) || keepClear.has(cellKey(t.position)))) ||
          [...blueprints].some(([key, other]) => key.startsWith(teamPrefix) && passage(other).some(p => planned.has(cellKey(p))))) return false
      addBlueprint(board, { id, cells })
      blueprints.set(project, blueprint)
      if (fitDeck) {
        const [dx, dz] = DIRECTIONS[direction]
        const cells = blueprint.protected.filter(p => p.x === at.x + dx && p.z === at.z + dz && p.y >= at.y)
        doors.set(blueprint, { cells, exit: { x: at.x + dx * 2, y: at.y, z: at.z + dz * 2 }, workers: new Map() })
      }
      log(`🏗 ${board.team}: общий план ${kind}, ${cells.length} клеток`)
    }
    // Стройка приёма жива, пока её ведут: срок продлевается каждым шагом, иначе через 30 с подтверждённые клетки
    // отменялись и крыша снова ждала стены (ревью 13.10).
    const own = blueprints.get(project)
    const door = doors.get(own)
    if (seenLayout && door) {
      const seenAir = new Set<string>(seenLayout.filter(row => AIR.test(row.existing?.name) && door.cells.some(p => cellKey(p) === cellKey(row.at))).map(row => cellKey(row.at)))
      door.workers.set(b.name, { seenAir, next: now() + 1500 })
    } else if (door && !request.fromHere && await clearPassage(b, context, project)) return true
    if (kind === 'beacon' && request.trail) {
      if (!own.trail || request.trail.seenAt > own.trail.seenAt) own.trail = request.trail
      own.expiresAt = own.trail.seenAt + 30000
    } else if (own?.expiresAt && !own.trail) own.expiresAt = Math.max(own.expiresAt, now() + 30000)
    const supportState = at => {
      const known = placed.get(board.team)
      return FACES.map(f => known?.has(cellKey({ x: at.x + f.x, y: at.y + f.y, z: at.z + f.z })) ? 1 : 0).join('')
    }
    let claimed: Set<string>
    const canAttempt = t => {
      const plan = blueprints.get(board.team + ':' + t.data.blueprint)
      const failed = failedFaces.get(plan)?.get(t.id)?.get(b.name)
      if (!failed || distance(m.p, failed.from) >= 2 || failed.stock !== stockAtStart || failed.faces !== supportState(t.position)) return true
      if (!failed.waiting) return false
      claimed ||= new Set(board.tasks().filter(t => t.claim).map(t => t.id))
      return !failed.waiting.some(id => claimed.has(id))
    }
    const owner = b.swarmTurnOwner, occupied: SwarmTask[] = []
    const select = (available: (t: SwarmTask) => boolean) => nextBuild(board, member, 25000, request.kind ? id : undefined,
      t => (!supportCells || supportCells.has(cellKey(t.position))) && canAttempt(t) && available(t))
    let nearFloor: SwarmTask[] | undefined
    let cell = select(t => {
      if (t.data.obstruction) { occupied.push(t); return false }
      if (!nearFloor && occupied.length) {
        const plan = blueprints.get(board.team + ':' + t.data.blueprint)
        if (plan?.kind === 'outpost') {
          const workDistance = distance(m.p, t.position)
          const earlier = occupied.filter(o => o.data.blueprint === t.data.blueprint && o.position.y === plan.origin.y - 1 &&
            (o.data.obstruction.self || o.data.obstruction.entity) && distance(m.p, o.position) <= 4.5 && distance(m.p, o.position) < workDistance)
          if (earlier.length) nearFloor = earlier
        }
      }
      return !nearFloor
    })
    // A volunteer may just have stepped off a closer floor cell. Inspect only the higher-ranked in-reach
    // part of this deck before claiming a farther job. Every other obstruction waits for normal reinspection.
    const queued = nearFloor ? [...nearFloor, ...occupied.filter(t => !nearFloor.includes(t))] : occupied
    const unknown = new Set<string>()
    for (let i = 0; !cell && i < queued.length;) {
      const beforeWalk = i === 0 && !!nearFloor
      const batch = queued.slice(i, i + (beforeWalk ? nearFloor.length : 64))
      i += batch.length
      const points = batch.map(t => ({ ...t.position, ...((beforeWalk || request.fromHere || t.data.obstruction.self) && { bodyFor: t.data.block }),
        ...((beforeWalk || request.fromHere || t.data.obstruction.exit) && { exitFor: t.data.block }) }))
      const reply = await b.c.call('swarm_pose', { inspectOnly: true, occupants: true, cells: points }).catch(() => null)
      if (!currentTurn(sw, b, generation) || b.swarmTurnOwner !== owner) return false
      if (beforeWalk && (!reply || reply.status === 'failed' && !reply.notStarted)) {
        cell = select(t => !t.data.obstruction)
        break
      }
      if (!reply || reply.notStarted || reply.status && reply.status !== 'done') return false
      const visible = new Map<string, { name: string; occupied?: boolean; exitBlocked?: boolean }>()
      for (const row of detail(reply)?.cells || []) if (row.at && row.existing) visible.set(cellKey(row.at), row.existing)
      const available = new Set<string>()
      for (const t of batch) {
        const seen = visible.get(cellKey(t.position))
        if (!seen) {
          if (!t.data.obstruction.exit && !t.data.obstruction.self) unknown.add(t.id)
        } else if (seen.name === t.data.block || !seen.occupied && seen.name !== t.data.obstruction.block &&
          (!(beforeWalk || request.fromHere) || seen.occupied === false && seen.exitBlocked === false) &&
          (!t.data.obstruction.exit || seen.exitBlocked === false)) available.add(t.id)
      }
      if (available.size || beforeWalk) cell = select(t => available.has(t.id) || beforeWalk && !t.data.obstruction)
    }
    // An optional marker with a known obstruction can yield to other work until someone sees it clear.
    if (!cell && unknown.size && !own?.trail && !request.fromHere) cell = select(t => unknown.has(t.id))
    if (!cell) return false
    const blueprint = blueprints.get(board.team + ':' + cell.data.blueprint)
    if (!blueprint) { board.release(cell.id, b.name, cell.claim.token); return false }
    const owns = () => currentTurn(sw, b, generation) && b.swarmTurnOwner === owner && renew(board, b, cell)
    const yieldTurn = () => { if (owner && b.swarmTurnOwner === owner) owner.cancelled = true }
    const interrupted = reply => {
      if (!reply?.notStarted && reply?.status !== 'interrupted' && reply?.status !== 'skipped' && reply?.code !== 'RESCUE_BUSY') return false
      if (currentTurn(sw, b, generation) && owner === b.swarmTurnOwner) {
        if (reply.by?.type === 'tactical' || reply.state?.tactics?.requireObservation) b.swarmFightReply = { ...reply, status: 'interrupted' }
        yieldTurn()
      }
      return true
    }
    // A walk can return after a dodge or a reassignment. Only the current worker may start the next physical action.
    const approach = async (to, range?: number) => {
      if (!owns()) return null
      const reply = await buildGo(b, to, range)
      return interrupted(reply) || !owns() ? null : reply || {}
    }
    try {
      const floor = blueprint.kind === 'outpost' && cell.position.y === blueprint.origin.y - 1
      const reuseMasonry = !floor && (blueprint.kind === 'shelter' || blueprint.kind === 'outpost')
      const stock = pos[b.name]?.inv || {}
      const selectMaterial = material => {
        if (!board.release(cell.id, b.name, cell.claim.token)) return false
        board.upsert({ ...cell, data: { ...cell.data, block: material } })
        cell = board.claim(cell.id, b.name, 25000)
        return !!cell
      }
      const needsSteady = supportCells && /^(sand|red_sand)$/.test(cell.data.block)
      let reliefSand: string | undefined
      if (floor || !stock[cell.data.block] || needsSteady) {
        const existing = detail(await b.c.call('swarm_pose', { at: cell.position, inspectOnly: true, ...(floor && { outpost: true }) })).existing
        if (!owns()) return false
        // У чертежа общий материал для снабжения, но на пустой клетке годится свой полнотелый блок.
        let material = cell.data.block
        if (floor && (existing?.solid || existing?.tread) || existing?.solid && reuseMasonry && masonry(existing.name)) material = existing.name
        else if (needsSteady || !stock[material] && existing?.name !== material) {
          material = Object.keys(stock).filter(n => stock[n] > 0 && BLOCK.test(n) && n !== 'sand' && n !== 'red_sand')
            .sort((a, c) => stock[c] - stock[a])[0]
          if (!material) {
            if (!supportCells && AIR.test(existing?.name)) reliefSand = ['sand', 'red_sand'].find(n => stock[n] > 0)
            if (!reliefSand) return false
          }
        }
        if (material && material !== cell.data.block && !selectMaterial(material)) return false
      }
      say(b, { ...cell, data: { ...cell.data, role: member.role } })
      if (!request.fromHere && distance(m.p, cell.position) > 4 && !await approach(cell.position, 3)) return false
      // The body checks the visible column beneath sand before clicking. Keep the team's original order until its receipt.
      let actualItem = reliefSand || cell.data.block
      const neighbours = !supportCells && blueprint.cells.filter(c => distance(c.at, cell.position) === 1).map(c => c.at)
      const repair = (floor || reuseMasonry) ? { match: match + '/' + board.team, token: cell.claim.token } : undefined
      const params = { kind: 'place', at: cell.position, item: actualItem, reuseMasonry, allies: context.members.map(a => a.id), protected: blueprint.protected.filter(p => cellKey(p) !== cellKey(cell.position)), contained: request.contained || [], timeoutSeconds: 3,
        ...(repair && { repair }), ...(floor && { outpostFloor: true }),
        ...(neighbours?.length && { supportCells: neighbours }) }
      // Снимок до каждого запроса: напарник может поставить опору, пока тело отвечает.
      let attempt: FaceFailure
      const place = async () => {
        if (!owns()) return null
        attempt = { from: { ...pos[b.name].p }, stock: buildStock(pos[b.name].inv), faces: supportState(cell.position) }
        const reply = await b.c.call('swarm_work', params), result = detail(reply)
        // A late tactical interrupt can carry an already confirmed block update.
        const stopped = interrupted(reply)
        if (!result.done && (stopped || !owns())) return null
        if (currentTurn(sw, b, generation) && b.swarmTurnOwner === owner) rememberExposure(b, result, generation)
        if (!result.done && result.aborted && (result.why === 'direct_threat' && result.safety && result.safety !== 'fight' ||
            ['cancelled', 'taking_damage', 'dead', 'disconnected_or_dead'].includes(result.why))) { yieldTurn(); return null }
        if (result.noVisibleSupport && result.viewpoint) attempt.from = { ...result.viewpoint }
        return result
      }
      let r = await place()
      if (!r) return false
      const rememberFace = () => {
        const cells = failedFaces.get(blueprint) || new Map(), workers = cells.get(cell.id) || new Map()
        workers.set(b.name, attempt); cells.set(cell.id, workers); failedFaces.set(blueprint, cells)
      }
      if (r.why === 'needs_stable_block') {
        if (!currentTurn(sw, b, generation)) return false
        const stable = Object.keys(pos[b.name]?.inv || {}).find(n => pos[b.name].inv[n] > 0 && BLOCK.test(n) && !/^(sand|red_sand)$/.test(n))
        if (!stable) { rememberFace(); return true }
        if (!selectMaterial(stable)) return false
        actualItem = params.item = stable
        r = await place()
        if (!r) return false
      }
      if (r.noVisibleSupport && r.reachableNeighbours?.length && !supportCells && currentTurn(sw, b, generation) &&
          Object.keys(m.inv || {}).some(n => m.inv[n] > 0 && BLOCK.test(n) && !/^(sand|red_sand)$/.test(n))) {
        const visible = new Set(r.reachableNeighbours.map(cellKey)), tasks = board.tasks()
        const done = new Set(tasks.filter(t => t.status === 'done').map(t => t.id))
        const ready = tasks.filter(t => t.kind === 'build' && t.data?.blueprint === cell.data.blueprint && t.status !== 'done' &&
          visible.has(cellKey(t.position)) && neighbours.some(p => cellKey(p) === cellKey(t.position)) &&
          (!t.dependsOn || t.dependsOn.every(k => done.has(k))) && (t.claim || canAttempt(t)))
        if (ready.length && board.release(cell.id, b.name, cell.claim.token)) {
          const working = ready.filter(t => t.claim).map(t => t.id)
          if (working.length) { attempt.waiting = working; rememberFace() }
          // If a helper withdraws, the wall can still be tried from another stance.
          if (ready.some(t => !t.claim)) await buildStep(b, context, { ...request, kind: blueprint.kind, id: cell.data.blueprint, origin: blueprint.origin },
            new Set(ready.map(t => cellKey(t.position))))
          return true
        }
      }
      const missingItem = () => r.why === `нет ${actualItem} в инвентаре`
      const obstruction = (afterMoving = false) => {
        if (r.exitBlocked && (r.exitBlocked !== b.name || afterMoving)) return { exit: true }
        if (r.selfOccupied && afterMoving) return { self: true }
        if (r.occupiedByEntity) return { entity: true }
        return r.why === 'occupied_cell' && r.before ? { block: r.before } : null
      }
      if (!request.fromHere && !r.done && !missingItem() && !obstruction() && (!r.aborted || r.why === 'direct_threat')) {
        let poses = detail(await b.c.call('swarm_pose', { at: cell.position })).poses || []
        if (!poses.length && !r.aborted) {
          const origin = blueprint.origin
          if (!await approach({ x: origin.x + .5, y: origin.y, z: origin.z - 3 + .5 })) return false
          poses = detail(await b.c.call('swarm_pose', { at: cell.position })).poses || []
        }
        const tried = new Set<string>()
        for (let attempt = 0; attempt < 4; attempt++) {
          const enemies = board.enemies()
          const clearance = p => Math.min(...enemies.map(e => distance(p, e.position)))
          // A threat abort permits a different, safer approach; the worker still decides whether work is safe.
          const at = poses.filter(p => !tried.has(cellKey(p)) && (!r.aborted || enemies.length && distance(p, m.p) > .4 && clearance(p) > clearance(m.p)))
            .sort((a, c) => placementRank(c) - placementRank(a) || (enemies.length ? clearance(c) - clearance(a) : 0) || distance(a, m.p) - distance(c, m.p))[0]
          if (!at) break
          tried.add(cellKey(at))
          const moved = await approach(at)
          if (!moved) return false
          poses = detail(await b.c.call('swarm_pose', { at: cell.position })).poses || []
          if (moved?.status === 'failed') continue
          const arrived = detail(moved).arrived
          if (arrived && [arrived.x, arrived.y, arrived.z].every(Number.isFinite)) m.p = { ...arrived }
          r = await place()
          if (!r) return false
          if (r.done || missingItem() || obstruction() || r.aborted && r.why !== 'direct_threat') break
        }
      }
      if (!r.done && !r.aborted && r.noVisibleSupport && blueprint.kind === 'outpost' && cell.position.y >= blueprint.origin.y + 1 &&
          BLOCK.test(actualItem) && !/^(sand|red_sand)$/.test(actualItem) && owns()) {
        const forbidden = at => [...blueprints].some(([key, plan]) => key.startsWith(teamPrefix) &&
          (plan.protected.some(p => cellKey(p) === cellKey(at)) || plan.cells.some(c => cellKey(c.at) === cellKey(at))))
        const knownStep = accessSteps.get(blueprint)
        const climbed = await climbOutpost({ bot: b, plan: blueprint, tasks: board.tasks(), cell, item: actualItem, count: stock[actualItem], allies: params.allies, contained: params.contained,
          position: pos[b.name].p, arena, forbidden, knownStep, detail, owns, approach, placeStep: async at => {
            const key = [generation, board.team, cellKey(at)].join(':')
            const projectKey = [generation, board.team, 'project', cell.data.blueprint].join(':')
            if (pendingSteps.has(key) || pendingSteps.has(projectKey) || accessSteps.get(blueprint) !== knownStep) return false
            pendingSteps.add(key); pendingSteps.add(projectKey)
            try {
              const reply = await b.c.call('swarm_work', { kind: 'place', at, item: actualItem, allies: params.allies,
                protected: blueprint.protected, contained: params.contained, timeoutSeconds: 3 })
              const result = detail(reply), stopped = interrupted(reply)
              if (generation !== sw.generation || blueprints.get(board.team + ':' + cell.data.blueprint) !== blueprint) return false
              if (result.done && result.at && cellKey(result.at) === cellKey(at) && result.after === actualItem) {
                accessSteps.set(blueprint, at)
                const own = placed.get(board.team) || new Map()
                own.set(cellKey(at), at); placed.set(board.team, own)
                for (const other of bots) if (other !== b && teamOf(other) === board.team) Promise.resolve(other.c?.call('swarm_keep', { cells: [at] })).catch(() => {})
                return !stopped && owns()
              }
              if (owns()) { rememberExposure(b, result, generation); if (result.aborted) yieldTurn() }
              return false
            } finally { pendingSteps.delete(key); pendingSteps.delete(projectKey) }
          } })
        if (!owns()) return false
        if (climbed) { r = await place(); if (!r) return false }
      }
      // Крыша кокона над целью и над щелью кладётся только сверху: грани соседних клеток крыши смотрят внутрь, с земли и в
      // прыжке их не видно («не к чему прислонить» — лаборатория 14.10, 21/23). Столб в 3 блока у угла кокона (по
      // диагонали: места у щелей держит оцепление) и кладка с его верха.
      // Столб к крыше не вышел — к той же крыше с того же места и с теми же блоками не повторять (retry.ts), а не 15 с.
      const roofSig = `${cellKey(blueprint.origin)}:${blockCount(pos[b.name]?.inv)}`
      if (!r.done && !r.aborted && !missingItem() && !obstruction() && blueprint.kind === 'cocoon' && cell.position.y === blueprint.origin.y + 2 && !sw.blocked(b, `roof:${b.name}`, roofSig)) {
        const o = blueprint.origin
        const corners = [[2, 2], [2, -2], [-2, 2], [-2, -2]].map(([dx, dz]) => ({ x: o.x + dx + .5, y: o.y, z: o.z + dz + .5 }))
          .sort((a, c) => distance(a, cell.position) - distance(c, cell.position))
        for (const base of corners) {
          const moved = await approach(base)
          if (!moved) return false
          if (moved?.status === 'failed') continue
          const reply = await b.c.call('swarm_pillar', { height: 3, item: actualItem, reserve: 0, arena, allies: context.members.map(a => a.id), timeoutSeconds: 12 })
          if (interrupted(reply) || !owns()) return false
          const up = detail(reply)
          if (!up.ok) { log(`🧱 ${b.name}: столб у кокона — ${up.why || 'не вышел'}`); continue }
          r = await place()
          if (!r) return false
          break
        }
        if (!r.done) sw.failed(b, `roof:${b.name}`, roofSig)
      }
      const exact = r.done && r.at && cellKey(r.at) === cellKey(cell.position)
      const witnessed = exact && r.already === true && r.confirmation === 'visible_existing' && r.before === r.after
      if (exact && reliefSand && r.after === reliefSand && !selectMaterial(reliefSand)) return false
      if (witnessed && r.after !== actualItem && (reuseMasonry && masonry(r.after) || floor && r.tread === true) && !selectMaterial(r.after)) return false
      const confirmed = exact && r.after === cell.data.block && board.ack(cell.id, b.name, { token: cell.claim.token, confirmed: true, position: r.at, block: r.after })
      if (confirmed) {
        if (!witnessed) telemetry.built++
        const own = placed.get(board.team) || new Map(), at = { ...r.at }
        own.set(cellKey(at), at); placed.set(board.team, own)
        if (blueprint.trail && generation === sw.generation && blueprints.get(board.team + ':' + cell.data.blueprint) === blueprint) {
          if (!r.already) blueprint.beaconChanged = true
          // The cap depends on the confirmed base. Two existing terrain blocks alone are not a team signal.
          if (blueprint.beaconChanged && at.y === blueprint.origin.y + 1) {
            const { id, position, seenAt } = blueprint.trail
            board.recordFact(b.name, seenAt, { id, kind: 'mark', position }, 30000)
          }
        }
        if (repair) repairReceipts.set(at, { id: cell.id, token: repair.token })
        failedFaces.get(blueprint)?.delete(cell.id)
        // Своя клетка — всей команде: бой её не прорубает (swarm_keep; «пробил его стенку» вскрывал кокон, 14.10).
        for (const o of bots) if (o !== b && teamOf(o) === board.team) Promise.resolve(o.c?.call('swarm_keep', { cells: [repair ? { ...r.at, repair } : r.at] })).catch(() => {})
        log(`🧱 ${b.name}: ${cell.id} ${witnessed ? 'готовая кладка ' + r.after : 'подтверждено'}`)
      } else {
        // A timed out worker must never reset a newer owner's claim.
        if (board.release(cell.id, b.name, cell.claim.token)) {
          const obstacle = obstruction(true)
          if (obstacle) {
            board.upsert({ ...cell, data: { ...cell.data, obstruction: obstacle } })
          } else if (r.noVisibleSupport) {
            rememberFace()
          } else {
            board.upsert({ ...cell, priority: (cell.priority || 60) - 1 })
            sw.failed(b, `work:${b.name}`, buildStock(pos[b.name]?.inv))
          }
        }
        log(`🧱 ${b.name}: ${r.why || 'клетка не подтверждена'} (${cell.id}${r.why === 'occupied_cell' && r.before ? ', ' + r.before : ''})`)
      }
      return !request.fromHere || confirmed || !!r.aborted
    } finally { if (cell) board.release(cell.id, b.name, cell.claim.token) }
  }
  async function clearPassage(b, context, project) {
    const plan = blueprints.get(project), door = doors.get(plan), me = pos[b.name]?.p
    if (!door || !me || !door.cells.some(p => distance(p, me) <= 5)) return false
    let eyes = door.workers.get(b.name)
    if (!eyes) { eyes = { seenAir: new Set(), next: 0 }; door.workers.set(b.name, eyes) }
    if (eyes.next > now()) return false
    eyes.next = now() + 1500
    const round = sw.generation, owner = b.swarmTurnOwner
    const reply = await b.c.call('swarm_pose', { inspectOnly: true, occupants: true, cells: door.cells }).catch(() => null)
    if (!currentTurn(sw, b, round) || b.swarmTurnOwner !== owner) return true
    if (reply?.notStarted || reply?.status === 'interrupted' || reply?.status === 'skipped' || blueprints.get(project) !== plan) return true
    if (!reply || reply.status && reply.status !== 'done') return false
    for (const row of detail(reply)?.cells || []) {
      const at = door.cells.find(p => cellKey(p) === cellKey(row.at))
      if (!at || !row.existing) continue
      if (AIR.test(row.existing.name)) { eyes.seenAir.add(cellKey(at)); continue }
      if (!row.existing.solid || row.existing.occupied || !eyes.seenAir.has(cellKey(at)) || !masonry(row.existing.name)) continue
      if (context.board.enemies().some(e => now() - e.seenAt < 1000 && distance(e.position, door.exit) <= 4)) continue
      if (await mineStep(b, context, null, { at, exit: door.exit, name: row.existing.name })) return true
    }
    return false
  }
  async function mineStep(b, context, foe, opening?: Opening) {
    const round = sw.generation, owner = b.swarmTurnOwner, board = context.board, me = pos[b.name]?.p
    const active = (reply?) => currentTurn(sw, b, round) && owner === b.swarmTurnOwner && !!pos[b.name]?.p &&
      !pos[b.name].rescuing && !reply?.notStarted && (!reply?.status || reply.status === 'done')
    const key = `mine:${b.name}`
    if (!me || !active() || !foe && !opening && sw.blocked(b, key)) return false
    if (exposedWorkers.has(b) && !await safeToResume(b, context.members)) return false
    let reserved = false
    const dig = async candidates => {
      if (!active()) return false
      let protectedCells = ownProtection(board)
      // Only this plan's nominated empty doorway is exempt. An overlapping task, floor or confirmed team block still protects it.
      if (opening) protectedCells = protectedCells.filter(p => p !== opening.at)
      for (const { at, name } of candidates) {
        if (protectedCells.some(p => cellKey(p) === cellKey(at))) continue
        const id = 'mine:' + cellKey(at), task = board.task(id)
        if (task?.claim) { reserved = true; continue }
        if (task?.status === 'done') board.cancel(id)
        board.upsert({ id, kind: 'mine', position: at })
        const claim = board.claim(id, b.name, 10000)
        if (!claim) { reserved = true; continue }
        try {
          const raw = await b.c.call('swarm_work', { kind: 'dig', at, item: name, protected: protectedCells, allies: context.members.map(a => a.id), timeoutSeconds: 4,
            ...(opening && { passageExit: opening.exit, arena }) })
          if (!active(raw)) return true
          const r = detail(raw)
          rememberExposure(b, r, round)
          if (r.why === 'allied_support') {
            reserved = true
            protectedCells = ownProtection(board)
            continue
          }
          if (r.done && board.ack(id, b.name, { token: claim.claim.token, confirmed: true }) && !r.already) {
            telemetry.dug++
            log(`⛏ ${b.name}: ${name} ${cellKey(at)} подтверждено`)
            if (!opening) await b.c.call('assist', { mode: 'pickup', maxD: 4, arena }).catch(() => {})
          }
          return true
        } finally { board.release(id, b.name, claim.claim.token) }
      }
      return false
    }
    if (opening) return dig([opening])
    if (foe) {
      // Клетки следующего шага вверх как в dig_to: освободить место для головы и сохранить ступень под ногами.
      const x = Math.floor(me.x), y = Math.floor(me.y), z = Math.floor(me.z)
      const dx = foe.position.x - me.x, dz = foe.position.z - me.z
      const cells = [{ x, y: y + 2, z }]
      if (Math.hypot(dx, dz) >= .8) {
        const nextX = x + (Math.abs(dx) >= Math.abs(dz) ? Math.sign(dx) : 0)
        const nextZ = z + (Math.abs(dx) < Math.abs(dz) ? Math.sign(dz) : 0)
        cells.push({ x: nextX, y: y + 1, z: nextZ }, { x: nextX, y: y + 2, z: nextZ })
      }
      const reply = await b.c.call('swarm_pose', { inspectOnly: true, cells })
      if (!active(reply)) return true
      return dig((detail(reply).cells || []).filter(row => row.existing?.solid && masonry(row.existing.name))
        .map(row => ({ at: row.at, name: row.existing.name })))
    }
    for (const name of ['smooth_sandstone', 'cobblestone', 'stone', 'oak_planks']) {
      const reply = await b.c.call('blocks_around', { find: name, seen: true, radius: 5, count: 12 })
      if (!active(reply)) return true
      const seen = detail(reply).found || []
      const options = seen.filter(q => q.y >= Math.floor(me.y)).sort((a, c) => distance(a, me) - distance(c, me))
      if (options.length && await dig(options.map(at => ({ at, name })))) return true
    }
    if (!reserved && active()) sw.failed(b, key)
    return false
  }
  // Прокоп к цели (натиск, пользователь 14.10: «человек в укрытии — кирками раскопать и забивать, и все пройдут к нему»):
  // туннель прямо на неё (dig_to: лучший инструмент, ступени, свои блоки под ноги, стоп у лавы/воды).
  // Подъём к цели выше 3+ бл. (крыша, столб, ярус; пользователь 14.10: «залез наверх — тупят внизу, не строятся, не ищут
  // кирку; на элитрах не долетают»). По порядку: элитры (3+ ракеты) — на свой сектор у цели; жемчуг (в 40 бл.); блоки на
  // высоту или кирка — маршрут к месту: goto сам ставит столбы из блоков (ND_SCAFFOLD_ANY) и копает сквозь стену (замер
  // 14.10: с песка на крышу +28 за одну попытку, 11 блоков); нечем — копать песок/землю руками (16 бл. ≈ 15 с), пока не
  // принесли (нужды → передачи).
  // Динамит (пользователь 14.10: «динамитом взрывать — достать игрока или разнести колизей к чертям; договариваться в
  // команде»): tnt_at ставит и поджигает у точки; свои в 5 бл. от неё — не ставить; поджёг — в чат «все назад», на доске
  // факт tnt (4.5 с — фитиль 4 с): свои рядом отходят (turn), сам — на 7 бл. прочь.
  async function blast(b, at, why) {
    const inv = pos[b.name]?.inv || {}
    // Не вышло поставить или поджечь у этой точки — с того же места к ней не повторять (retry.ts), а не 6 с; горящий — факт tnt.
    const spot = cellKey({ x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) })
    if (!inv.tnt || !(inv.flint_and_steel || inv.fire_charge) || sw.blocked(b, `tnt:${b.name}`, spot)) return false
    if (bots.some(o => o !== b && teamOf(o) === teamOf(b) && alive(o.name) && pos[o.name]?.p && distance(pos[o.name].p, at) < 5)) return false
    // Один динамит у цели за раз (горящий в 6 бл. от точки — ждать).
    if (boardOf(b).facts().some(f => f.id.startsWith('tnt:') && f.position && distance(f.position, at) < 6)) return false
    const r = detail(await b.c.call('tnt_at', { at }).catch(e => ({ why: e.message })))
    log(`💣 ${b.name}: динамит ${why} — ${r.lit ? 'горит' : String(r.why || 'нет').slice(0, 60)}`)
    if (!r.lit || !r.placed) { sw.failed(b, `tnt:${b.name}`, spot); return false }
    boardOf(b).recordFact(b.name, now(), { id: `tnt:${cellKey(r.placed)}`, kind: 'mark', position: r.placed }, 4500)
    say2(`💣 ${b.name.replace(/^NeuroFarm/, '')}: динамит ${why} — все назад!`, 'red')
    const me = pos[b.name].p, d = Math.hypot(me.x - r.placed.x, me.z - r.placed.z) || 1
    await go(b, { x: me.x + (me.x - r.placed.x) / d * 7, y: me.y, z: me.z + (me.z - r.placed.z) / d * 7 }, 1.5, 3)
    return true
  }
  return { buildStep, mineStep, blast, observeBreaches }
}
