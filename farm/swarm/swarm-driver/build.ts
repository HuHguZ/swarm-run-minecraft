// Рой: стройка по чертежу, копка вверх к врагу, динамит.
import { type BlueprintCell, addBlueprint, nextBuild } from '../../../daemon/src/swarm'
import { swarmBlueprint } from '../../../daemon/src/swarm-work'
import { BLOCK, distance, cellKey } from './common'
import type { SwarmDriverCtx } from './common'

export function swarmBuild (sw: SwarmDriverCtx) {
  const { now, pos, home, arena, log, bots, alive, cooldown, blueprints, telemetry, placed, detail, say, renew, buildGo, teamOf, ownProtection, boardOf, say2, go } = sw
  async function buildStep(b, context, request: any = {}) {
    // Пауза после отказа клетки — для всех путей стройки (31ao, выступ 15.10: «не к чему прислонить» 13 раз за 25 с по задаче build).
    if ((cooldown.get(`work:${b.name}`) || 0) > now()) return false
    const { board, member } = context, m = pos[b.name]
    let item = Object.keys(m.inv || {}).find(n => BLOCK.test(n) && m.inv[n] > 0)
    if (!item) return false
    const start = request.origin || home(b), kind = request.kind || 'shelter'
    const at = { x: Math.floor(start.x), y: Math.floor(request.origin?.y ?? m.p.y), z: Math.floor(start.z) }
    const id = request.id || (kind === 'shelter' ? 'shelter' : `${kind}:${cellKey(at)}`), project = board.team + ':' + id
    if (!blueprints.has(project)) {
      // Кокон и отсечка — на одну цель: новое место (цель ушла) отменяет старую стройку того же вида, иначе её клетки
      // держат доску до истечения и новый чертёж отклоняется как пересекающийся.
      if (kind === 'cocoon' || kind === 'cutoff') for (const [key, old] of [...blueprints]) if (key.startsWith(board.team + ':') && old.kind === kind) {
        for (const t of board.tasks().filter(t => t.kind === 'build' && t.data?.blueprint === key.slice(board.team.length + 1))) board.cancel(t.id)
        blueprints.delete(key)
      }
      const blueprint: ReturnType<typeof swarmBlueprint> & { material?: string; expiresAt?: number } = request.cells ? { kind, origin: at, cells: request.cells, protected: request.protected || [] } : swarmBlueprint(kind, at, request.direction || 'north')
      if (arena && blueprint.cells.some(c => Math.abs(c.at.x + .5 - arena.x) + .3 >= arena.r || Math.abs(c.at.z + .5 - arena.z) + .3 >= arena.r || c.at.y <= (arena.killY ?? -64))) return false
      const total = new Map<string, number>()
      for (const own of context.members) for (const [name, count] of Object.entries(own.inventory) as [string, number][]) if (BLOCK.test(name)) total.set(name, (total.get(name) || 0) + count)
      item = [...total].sort((a, c) => c[1] - a[1])[0]?.[0] || item
      blueprint.material = item
      if (kind === 'cocoon' || kind === 'cutoff') blueprint.expiresAt = now() + 30000
      blueprints.set(project, blueprint)
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
      if (board.tasks().some(t => t.kind === 'build' && cells.some(c => cellKey(c.position) === cellKey(t.position)))) { blueprints.delete(project); return false }
      addBlueprint(board, { id, cells })
      log(`🏗 ${board.team}: общий план ${kind}, ${cells.length} клеток`)
    }
    // Стройка приёма жива, пока её ведут: срок продлевается каждым шагом, иначе через 30 с подтверждённые клетки
    // отменялись и крыша снова ждала стены (ревью 13.10).
    const own = blueprints.get(project)
    if (own?.expiresAt) own.expiresAt = Math.max(own.expiresAt, now() + 30000)
    let cell = nextBuild(board, member, 25000, request.kind ? id : undefined)
    if (!cell) return false
    const blueprint = blueprints.get(board.team + ':' + cell.data.blueprint)
    if (!blueprint) { board.release(cell.id, b.name, cell.claim.token); return false }
    try {
      if (blueprint.kind === 'outpost' && cell.position.y === blueprint.origin.y - 1) {
        const existing = detail(await b.c.call('swarm_pose', { at: cell.position, inspectOnly: true })).existing
        if (existing?.solid && existing.name !== cell.data.block && board.release(cell.id, b.name, cell.claim.token)) {
          board.upsert({ ...cell, data: { ...cell.data, block: existing.name } })
          cell = board.claim(cell.id, b.name, 25000)
          if (!cell) return false
        }
      }
      say(b, { ...cell, data: { ...cell.data, role: member.role } })
      if (distance(m.p, cell.position) > 4) { if (!renew(board, b, cell)) return false; await buildGo(b, cell.position, 3) }
      const actualItem = cell.data.block
      const params = { kind: 'place', at: cell.position, item: actualItem, allies: context.members.map(a => a.id), protected: blueprint.protected.filter(p => cellKey(p) !== cellKey(cell.position)), contained: request.contained || [], timeoutSeconds: 3 }
      if (!renew(board, b, cell)) return false
      let r = detail(await b.c.call('swarm_work', params))
      if (!r.done && (!r.aborted || r.why === 'direct_threat')) {
        let poses = detail(await b.c.call('swarm_pose', { at: cell.position })).poses || []
        if (!poses.length && !r.aborted) {
          const origin = blueprint.origin
          if (!renew(board, b, cell)) return false
          await buildGo(b, { x: origin.x + .5, y: origin.y, z: origin.z - 3 + .5 })
          poses = detail(await b.c.call('swarm_pose', { at: cell.position })).poses || []
        }
        const tried = new Set<string>()
        for (let attempt = 0; attempt < 4; attempt++) {
          const enemies = board.enemies()
          const clearance = p => Math.min(...enemies.map(e => distance(p, e.position)))
          // A threat abort permits a different, safer approach; the worker still decides whether work is safe.
          const at = poses.filter(p => !tried.has(cellKey(p)) && (!r.aborted || enemies.length && distance(p, m.p) > .4 && clearance(p) > clearance(m.p)))
            .sort((a, c) => (enemies.length ? clearance(c) - clearance(a) : 0) || distance(a, m.p) - distance(c, m.p))[0]
          if (!at) break
          tried.add(cellKey(at))
          if (!renew(board, b, cell)) return false
          const moved = await buildGo(b, at)
          poses = detail(await b.c.call('swarm_pose', { at: cell.position })).poses || []
          if (moved?.status === 'failed') continue
          const arrived = detail(moved).arrived
          if (arrived && [arrived.x, arrived.y, arrived.z].every(Number.isFinite)) m.p = { ...arrived }
          if (!renew(board, b, cell)) return false
          r = detail(await b.c.call('swarm_work', params))
          if (r.done || r.aborted && r.why !== 'direct_threat') break
        }
      }
      // Крыша кокона над целью и над щелью кладётся только сверху: грани соседних клеток крыши смотрят внутрь, с земли и в
      // прыжке их не видно («не к чему прислонить» — лаборатория 14.10, 21/23). Столб в 3 блока у угла кокона (по
      // диагонали: места у щелей держит оцепление) и кладка с его верха.
      if (!r.done && !r.aborted && blueprint.kind === 'cocoon' && cell.position.y === blueprint.origin.y + 2 && (cooldown.get(`roof:${b.name}`) || 0) <= now()) {
        cooldown.set(`roof:${b.name}`, now() + 15000)
        const o = blueprint.origin
        const corners = [[2, 2], [2, -2], [-2, 2], [-2, -2]].map(([dx, dz]) => ({ x: o.x + dx + .5, y: o.y, z: o.z + dz + .5 }))
          .sort((a, c) => distance(a, cell.position) - distance(c, cell.position))
        for (const base of corners) {
          if (!renew(board, b, cell)) return false
          const moved = await buildGo(b, base)
          if (moved?.status === 'failed') continue
          const up = detail(await b.c.call('swarm_pillar', { height: 3, item: actualItem, reserve: 0, arena, allies: context.members.map(a => a.id), timeoutSeconds: 12 }))
          if (!up.ok) { log(`🧱 ${b.name}: столб у кокона — ${up.why || 'не вышел'}`); continue }
          if (!renew(board, b, cell)) return false
          r = detail(await b.c.call('swarm_work', params))
          break
        }
      }
      if (r.done && r.at && cellKey(r.at) === cellKey(cell.position) && r.after === actualItem && board.ack(cell.id, b.name, { token: cell.claim.token, confirmed: true, position: r.at, block: r.after })) {
        telemetry.built++
        const own = placed.get(board.team) || []; own.push({ ...r.at }); placed.set(board.team, own)
        // Своя клетка — всей команде: бой её не прорубает (swarm_keep; «пробил его стенку» вскрывал кокон, 14.10).
        for (const o of bots) if (o !== b && teamOf(o) === board.team) Promise.resolve(o.c?.call('swarm_keep', { cells: [r.at] })).catch(() => {})
        log(`🧱 ${b.name}: ${cell.id} подтверждено`)
      } else {
        // A timed out worker must never reset a newer owner's claim.
        if (board.release(cell.id, b.name, cell.claim.token)) board.upsert({ ...cell, priority: (cell.priority || 60) - 1 })
        // Нет блока плана в рюкзаке («нет oak_planks» каждые 2 с, арена 40) — 15 с не браться: принесут передачи или возьмёт другой.
        // Клетка вне прорисовки (unloaded_cell — далеко) — тоже 15 с: каждые 2 с тот же отказ (крыша s28: 13 раз за 20 с).
        cooldown.set(`work:${b.name}`, now() + (/в инвентаре|unloaded_cell|occupied_cell|не к чему прислонить|нет видимой опоры/.test(r.why || '') ? 15000 : 2000)); log(`🧱 ${b.name}: ${r.why || 'клетка не подтверждена'}`)
      }
      return true
    } finally { if (cell) board.release(cell.id, b.name, cell.claim.token) }
  }
  async function mineStep(b, context, foe) {
    if ((cooldown.get(`mine:${b.name}`) || 0) > now()) return false
    cooldown.set(`mine:${b.name}`, now() + 3000)
    const m = pos[b.name], protectedCells = ownProtection(context.board)
    if (foe) await b.c.call('look_at', { ...foe.position, y: foe.position.y + 1 })
    for (const name of ['smooth_sandstone', 'cobblestone', 'stone', 'oak_planks']) {
      const seen = detail(await b.c.call('blocks_around', { find: name, seen: true, radius: 5, count: 12 })).found || []
      const candidate = seen.filter(q => q.y >= Math.floor(m.p.y) && !protectedCells.some(p => cellKey(p) === cellKey(q))).sort((a, c) => distance(a, m.p) - distance(c, m.p))[0]
      if (!candidate) continue
      const id = 'mine:' + cellKey(candidate)
      // Клетка снова занята блоком (её видно глазами) — старая выполненная задача не должна запрещать копку (ревью 13.10).
      if (context.board.tasks().some(t => t.id === id && t.status === 'done')) context.board.cancel(id)
      context.board.upsert({ id, kind: 'mine', position: { x: candidate.x, y: candidate.y, z: candidate.z } })
      const claim = context.board.claim(id, b.name, 10000)
      if (!claim) continue
      try {
        const r = detail(await b.c.call('swarm_work', { kind: 'dig', at: candidate, protected: protectedCells, allies: context.members.map(a => a.id), timeoutSeconds: 4 }))
        if (r.done && context.board.ack(id, b.name, { token: claim.claim.token, confirmed: true })) { telemetry.dug++; log(`⛏ ${b.name}: ${name} ${cellKey(candidate)} подтверждено`); await b.c.call('assist', { mode: 'pickup', maxD: 4, arena }).catch(() => {}) }
        return true
      } finally { context.board.release(id, b.name, claim.claim.token) }
    }
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
    if (!inv.tnt || !(inv.flint_and_steel || inv.fire_charge) || (cooldown.get(`tnt:${b.name}`) || 0) > now()) return false
    if (bots.some(o => o !== b && teamOf(o) === teamOf(b) && alive(o.name) && pos[o.name]?.p && distance(pos[o.name].p, at) < 5)) return false
    // Один динамит у цели за раз (горящий в 6 бл. от точки — ждать).
    if (boardOf(b).facts().some(f => f.id.startsWith('tnt:') && f.position && distance(f.position, at) < 6)) return false
    cooldown.set(`tnt:${b.name}`, now() + 6000)
    const r = detail(await b.c.call('tnt_at', { at }).catch(e => ({ why: e.message })))
    log(`💣 ${b.name}: динамит ${why} — ${r.lit ? 'горит' : String(r.why || 'нет').slice(0, 60)}`)
    if (!r.lit || !r.placed) return false
    boardOf(b).recordFact(b.name, now(), { id: `tnt:${cellKey(r.placed)}`, kind: 'mark', position: r.placed }, 4500)
    say2(`💣 ${b.name.replace(/^NeuroFarm/, '')}: динамит ${why} — все назад!`, 'red')
    const me = pos[b.name].p, d = Math.hypot(me.x - r.placed.x, me.z - r.placed.z) || 1
    await go(b, { x: me.x + (me.x - r.placed.x) / d * 7, y: me.y, z: me.z + (me.z - r.placed.z) / d * 7 }, 1.5, 3)
    return true
  }
  return { buildStep, mineStep, blast }
}
