import { SwarmBoard, planPvp, planTransfers, addBlueprint, nextBuild, assessSwarmFight, mustFlee, ownedCount } from '../daemon/src/swarm'
const { swarmBlueprint } = require('../daemon/src/swarm-work')
const WEAPON = /(_sword|_axe|_spear)$|^(mace|trident|bow|crossbow)$/
const BLOCK = /^(cobblestone|stone|dirt|smooth_sandstone|sandstone|netherrack|.*_planks)$/
const FOOD = /^(bread|cooked_.*|golden_apple|enchanted_golden_apple)$/
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const cellKey = p => `${p.x},${p.y},${p.z}`

// This adapter sees own bodies and allied reports; enemy daemon snapshots never enter the board.
// now — часы решений: в ffa это подменённый Date.now (игровое время при ускорении), в лаборатории — свои игровые часы.
export function createSwarmDriver({ bots, pos, alive, arena, home, hostile, log, arms = false, now = () => Date.now() }: any) {
  const boards = new Map<string, SwarmBoard>()
  const blueprints = new Map<string, any>()
  const transfers = new Map<string, any>()
  const planned = new Map<string, Map<string, any>>()
  const plannedAt = new Map<string, number>()
  const visited = new Map<string, Map<string, number>>()
  const cooldown = new Map<string, number>()
  const telemetry = { observed: 0, built: 0, dug: 0, transfers: 0, searches: 0 }
  let generation = 0
  let positionQueries = 0
  const teamOf = b => b.team || b.name
  const boardOf = b => {
    const team = teamOf(b)
    if (!boards.has(team)) boards.set(team, new SwarmBoard(team, () => now(), 8000))
    return boards.get(team)!
  }
  const membersOf = b => {
    const roster = bots.filter(o => teamOf(o) === teamOf(b))
    const stock = roster.filter(a => alive(a.name)).flatMap(a => Object.keys(pos[a.name]?.inv || {}))
    // Номер в составе команды, а не среди живых: смерть одного не перетасовывает роли всех (ревью 13.10).
    return roster.filter(o => alive(o.name) && pos[o.name]?.p).map(o => member(o, roster.indexOf(o), stock, b))
  }
  const member = (o, k, stock, b) => {
    const m = pos[o.name], inv = m.inv || {}, names = Object.keys(inv)
    const heal = Object.entries(m.potions || {}).some(([n, c]: any) => /^splash_.*(healing|regeneration)$/.test(n) && c > 0)
    const role = heal && k % 3 === 1 ? 'healer' : names.some(n => /_pickaxe$/.test(n)) && k % 3 === 0 ? 'miner-builder' : inv.bow && inv.arrow && k % 2 ? 'ranged' : k % 3 === 2 ? 'flank' : 'fighter'
    const reserve: Record<string, number> = {}, needs: Record<string, number> = {}
    for (const n of names) reserve[n] = BLOCK.test(n) ? 16 : FOOD.test(n) ? 4 : WEAPON.test(n) || /_pickaxe$/.test(n) ? 1 : /potion|pearl|totem|wind_charge/.test(n) ? 1 : 0
    const melee = names.filter(n => /(_sword|_axe)$/.test(n))
    if (melee.length > 1) for (const n of melee.slice(1)) reserve[n] = 0
    if (!names.some(n => WEAPON.test(n))) { const weapon = stock.find(n => WEAPON.test(n)); if (weapon) needs[weapon] = 1 }
    for (const [slot, suffix] of Object.entries({ head: '_helmet', torso: '_chestplate', legs: '_leggings', feet: '_boots' })) {
      const spare = stock.find(n => n.endsWith(suffix))
      if (!m.armor?.[slot] && spare) needs[spare] = 1
      if (m.armor?.[slot]) for (const n of names.filter(n => n.endsWith(suffix))) reserve[n] = 0
    }
    if (inv.bow || inv.crossbow) needs.arrow = 16
    if (role === 'miner-builder') needs[[...blueprints].find(([key]) => key.startsWith(teamOf(b) + ':'))?.[1]?.material || 'cobblestone'] = 16
    if (m.hp < 16 && !names.some(n => FOOD.test(n))) needs.cooked_beef = 4
    const worn = Object.values(m.armor || {}).filter(Boolean).length
    const strength = m.hp * (1 + (names.some(n => WEAPON.test(n)) ? 1 : 0)) * (1 + worn * .25)
    const weapon = names.find(n => /(_sword|_axe|_spear)$|^(mace|trident)$/.test(n))
    const ench = { sharpness: Math.max(0, ...(m.enchants || []).filter(it => it.name === weapon).map(it => it.ench?.sharpness || 0)), protection: (m.enchants || []).filter(it => it.slot >= 5 && it.slot <= 8).reduce((sum, it) => sum + (it.ench?.protection || 0), 0) }
    // Левая рука (щит, тотем) в рюкзак не входит: без неё надетый щит для доски «пропадал», и кольцо не строилось.
    const offHand = typeof m.offHand === 'string' ? m.offHand : m.offHand?.item || undefined
    if (offHand === 'shield') reserve.shield = 1
    return { id: o.name, team: teamOf(o), position: m.p, health: m.hp, strength, role, canHeal: heal, inventory: inv, reserve, needs, armor: m.armor || {}, offHand, weapon, ench }
  }
  // seenAt — когда спросили (наблюдение не старше запроса статуса), без него — сейчас.
  const observe = (b, sightings, seenAt?: number) => {
    const board = boardOf(b), at = Number.isFinite(seenAt) ? Math.min(seenAt!, now()) : now()
    board.setMembers(membersOf(b))
    for (const e of sightings || []) if (hostile(b, e.id) && board.observe(b.name, at, e)) telemetry.observed++
    preempt(b)
  }
  const refresh = (b) => {
    const board = boardOf(b), team = teamOf(b), members = membersOf(b)
    for (const [key, blueprint] of blueprints) if (key.startsWith(team + ':') && blueprint.expiresAt && blueprint.expiresAt <= now()) {
      for (const t of board.tasks().filter(t => t.data?.blueprint === key.slice(team.length + 1))) board.cancel(t.id)
      blueprints.delete(key)
    }
    board.setMembers(members)
    if (now() - (plannedAt.get(team) || 0) >= 500 || !planned.has(team)) {
      const was = board.doctrineState()?.doctrine, held = board.teamFight?.engage
      planned.set(team, planPvp(board, members, { quorum: Math.min(2, Math.max(1, members.length)), doctrine: process.env.SWARM_DOCTRINE as any || undefined }))
      const chosen = board.doctrineState()?.doctrine, fight = board.teamFight
      if (chosen && chosen !== was) log(`🧭 ${team}: приём ${was || '—'} → ${chosen}`)
      if (fight && fight.engage !== held) log(`⚖ ${team}: бой ${fight.engage ? 'держим' : 'не держим'} — ${fight.ours} на ${fight.theirs}, потери ≈ ${fight.ourLoss.toFixed(1)} : ${fight.theirLoss.toFixed(1)}${fight.wipedUs && !fight.wipedThem ? ', нас выносят' : ''}`)
      transfers.set(team, planTransfers(board, members))
      plannedAt.set(team, now())
    }
    return { board, members, member: members.find(m => m.id === b.name), task: planned.get(team)?.get(b.name) }
  }
  const say = (b, task) => {
    const identity = `${task.kind}:${task.data?.target || task.data?.ally || task.data?.blueprint || ''}:${task.data?.doctrine || ''}`
    if (b.swarmSaid === identity) return
    b.swarmSaid = identity
    if (task.data?.doctrine) b.swarmDoctrine = task.data.doctrine
    log(`🐜 ${b.name} [${task.data?.role || ''}/${task.data?.doctrine || ''}]: ${task.kind}${task.data?.target ? ' → ' + task.data.target : ''}${task.data?.ally ? ' для ' + task.data.ally : ''}${task.data?.panic && task.data.reason ? ` (${task.data.reason})` : ''}`)
  }
  // Демон пускает цель похода, только если и сама точка, и центр её клетки с полушириной тела (0.3) лежат в r − 1:
  // прижим к r − 1 давал «outside arena bounds» и повтор каждые 200 мс у края (разбор 13.10) — прижимаем к r − 2.
  const bounded = at => ({ ...at, x: Math.max(arena.x - arena.r + 2, Math.min(arena.x + arena.r - 2, at.x)), z: Math.max(arena.z - arena.r + 2, Math.min(arena.z + arena.r - 2, at.z)) })
  const go = (b, at, range = 2, seconds = 4) => b.c.call('goto', { ...bounded(at), range, timeoutSeconds: seconds, arena, _hunt: true })
  const buildGo = (b, at, range = .25) => b.c.call('goto', { ...at, range, timeoutSeconds: 4, surface: 'strict', arena, _hunt: true })
  const detail = r => r?.detail || r || {}
  const execute = async (b, method, params: any = {}) => {
    let r = await b.c.call(method, params)
    while (r?.status === 'pending' && r.token !== undefined && alive(b.name)) { await new Promise(resolve => setTimeout(resolve, 50)); r = await b.c.call('status', { token: r.token }) }
    return detail(r)
  }
  const release = (b, died = false) => { const board = boardOf(b); if (died && b.swarmDoctrine) board.noteTacticOutcome(b.name, b.swarmDoctrine, false); board.releaseOwner(b.name) }
  // Поставленное своими за раунд не копается никогда: чертёж истекает, а кокон, стенка и укрытие стоят (лаборатория 13.10:
  // строитель, потеряв цель из виду, разобрал свой же кокон как «ближайший камень»).
  const placed = new Map<string, any[]>()
  const ownProtection = board => [...board.tasks().filter(t => t.kind === 'build').map(t => t.position), ...[...blueprints.entries()].filter(([key]) => key.startsWith(board.team + ':')).flatMap(([, plan]) => plan.protected), ...(placed.get(board.team) || [])]
  const renew = (board, b, claim) => board.renew(claim.id, b.name, claim.claim.token, 25000)
  async function buildStep(b, context, request: any = {}) {
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
      const blueprint = request.cells ? { kind, origin: at, cells: request.cells, protected: request.protected || [] } : swarmBlueprint(kind, at, request.direction || 'north')
      if (arena && blueprint.cells.some(c => Math.abs(c.at.x + .5 - arena.x) + .3 >= arena.r || Math.abs(c.at.z + .5 - arena.z) + .3 >= arena.r || c.at.y <= (arena.killY ?? -64))) return false
      const total = new Map<string, number>()
      for (const own of context.members) for (const [name, count] of Object.entries(own.inventory) as [string, number][]) if (BLOCK.test(name)) total.set(name, (total.get(name) || 0) + count)
      item = [...total].sort((a, c) => c[1] - a[1])[0]?.[0] || item
      blueprint.material = item
      if (kind === 'cocoon' || kind === 'cutoff') blueprint.expiresAt = now() + 30000
      blueprints.set(project, blueprint)
      const cells = blueprint.cells.map(c => ({ id: cellKey(c.at), position: c.at, block: item }))
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
        cooldown.set(`work:${b.name}`, now() + 2000); log(`🧱 ${b.name}: ${r.why || 'клетка не подтверждена'}`)
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
        if (r.done && context.board.ack(id, b.name, { token: claim.claim.token, confirmed: true })) { telemetry.dug++; log(`⛏ ${b.name}: ${name} ${cellKey(candidate)} подтверждено`); await b.c.call('assist', { mode: 'pickup', maxD: 4 }).catch(() => {}) }
        return true
      } finally { context.board.release(id, b.name, claim.claim.token) }
    }
    return false
  }
  async function loot(b, board) {
    if (!arms || (cooldown.get(`loot:${b.name}`) || 0) > now()) return false
    cooldown.set(`loot:${b.name}`, now() + 4000)
    const chests = detail(await b.c.call('blocks_around', { find: 'chest', seen: true, radius: 16, count: 8 })).found || []
    for (const at of chests) {
      if (Math.abs(at.x + .5 - arena.x) + .3 >= arena.r || Math.abs(at.z + .5 - arena.z) + .3 >= arena.r || at.y <= (arena.killY ?? -64) || board.enemies().some(e => now() - e.seenAt < 3000 && distance(e.position, at) < 14)) continue
      const id = 'chest:' + cellKey(at)
      // Открытый сундук — «проверен» на минуту: пустой не обходят каждые 4 с, пополненный (большая арена, раз в 20 с)
      // снова берут (ревью 14.10: отметка была навсегда, а пустой не отмечался вовсе).
      if (board.tasks().some(t => t.id === id && t.status === 'done' && now() - (t.doneAt ?? now()) < 60000)) continue
      board.upsert({ id, kind: 'scout', position: { x: at.x, y: at.y, z: at.z }, data: { loot: true } })
      const claim = board.claim(id, b.name, 15000)
      if (!claim) continue
      try {
        if (distance(pos[b.name].p, at) > 3) { if (!renew(board, b, claim)) return false; await go(b, at, 2) }
        if (!renew(board, b, claim)) return false
        const r = await b.c.call('chest_take', { item: 'all', x: at.x, y: at.y, z: at.z, timeoutSeconds: 8 })
        const d = detail(r), moved = Object.values(d.took || d.moved || {}).reduce((s: number, n: any) => s + (Number(n) || 0), 0)
        if (Number(moved) > 0 || d.at && d.contents) board.ack(id, b.name, { token: claim.claim.token, confirmed: true })
        if (Number(moved) > 0) { await b.c.call('armor'); log(`🧰 ${b.name}: ${id} +${moved}`) }
        return Number(moved) > 0
      } finally { board.release(id, b.name, claim.claim.token) }
    }
    return false
  }
  async function transfer(b, context) {
    const task = (transfers.get(teamOf(b)) || []).find(t => t.assignedTo === b.name && t.status !== 'done')
    if (!task || (cooldown.get(task.id) || 0) > now()) return false
    const recipient = bots.find(o => o.name === task.data.recipient)
    // Получатель в бою или бегстве — не выдёргивать его подбором (ревью 13.10): обмен подождёт.
    if (!recipient || recipient.swarmExecuting && /^(fight|flee)$/.test(recipient.swarmTask?.kind || '')) return false
    const claim = context.board.claim(task.id, b.name, 15000)
    if (!claim) return false
    try {
      const fresh = await Promise.all([b.c.call('status'), recipient.c.call('status')])
      const before = ownedCount(fresh[1]?.state || {}, task.data.item)
      const have = fresh[0]?.state?.inventory?.[task.data.item] || 0
      if (have - task.data.reserve < task.data.count) return false
      if (distance(pos[b.name].p, pos[recipient.name].p) > 3) await go(b, pos[recipient.name].p)
      if (!renew(context.board, b, claim)) return false
      const r = detail(await b.c.call('assist', { mode: 'toss', ally: recipient.name, item: task.data.item, count: task.data.count }))
      if (r.ok) await recipient.c.call('assist', { mode: 'pickup', item: task.data.item })
      const result = await recipient.c.call('status')
      const received = ownedCount(result?.state || {}, task.data.item) - before >= task.data.count
      if (result?.state?.inventory && pos[recipient.name]) pos[recipient.name].inv = result.state.inventory
      if (result?.state?.armor && pos[recipient.name]) pos[recipient.name].armor = result.state.armor
      const donor = await b.c.call('status')
      if (donor?.state?.inventory && pos[b.name]) pos[b.name].inv = donor.state.inventory
      if (donor?.state?.armor && pos[b.name]) pos[b.name].armor = donor.state.armor
      if (received && context.board.ack(task.id, b.name, { token: claim.claim.token, confirmed: true })) telemetry.transfers++
      log(`📦 ${b.name} → ${recipient.name}: ${task.data.item}×${task.data.count}, ${received ? 'получено' : 'не подтверждено'}`)
      cooldown.set(task.id, now() + 4000)
      return true
    } finally { context.board.release(task.id, b.name, claim.claim.token) }
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
      !(o.swarmExecuting && /^(fight|flee)$/.test(o.swarmTask?.kind || ''))).sort((a, c) => distance(pos[a.name].p, m.p) - distance(pos[c.name].p, m.p))[0]
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
      if (!dry.plan || !renew(board, b, claim)) return false
      const ready = await execute(thrower, 'wind_boost', { ally: b.name, plan: dry.plan, arena, dryRun: true })
      if (!ready.ok || !Number.isFinite(dry.gameTick) || !Number.isFinite(ready.gameTick)) return false
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
    if (positionQueries >= 2 || (cooldown.get(`position:${b.name}`) || 0) > now()) return false
    cooldown.set(`position:${b.name}`, now() + 20000)
    positionQueries++; b.swarmBusyUntil = now() + 20000
    const round = generation
    try {
      const m = pos[b.name], board = context.board
      const query = await execute(b, 'swarm_position', { purpose, arena, enemies: board.enemies().map(e => ({ id: e.id })), radius: 12, limit: 6, reserve: context.member.reserve, budgetMs: 1500 })
      if (round !== generation || !alive(b.name)) return false
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
        if (round !== generation || !alive(b.name)) return false
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
    } finally { positionQueries--; delete b.swarmBusyUntil }
  }
  const rangedAdvantage = b => {
    const here = b.swarmPosition, m = pos[b.name], enemies = boardOf(b).enemies()
    return !!here && here.purpose === 'ranged' && m?.inv?.bow && m.inv.arrow && distance(m.p, here.at) < 1 && enemies.length && enemies.every(e => now() - e.seenAt < 1000 && e.position.y + 6 < m.p.y && !['bow', 'aerial', 'blast'].includes(e.threat) && !/bow|trident|end_crystal|respawn_anchor/.test(e.equipment?.weapon || ''))
  }
  // Фаза приёма: смена её посреди долгого дела (бой — до 12 игровых с) обрывает дело — иначе старый фронт линии
  // дерётся после смены, фонтан не смыкается, засада не бьёт. Смена цели в том же бою фазой не считается.
  // Только фазы приёмов: обычное перераспределение (бой ↔ резерв) не обрывает начатое, иначе бой дёргается.
  // Раненый, которому велено отходить (recover), — тоже фаза: бой до 12 с добивал его (лаборатория 13.10, линия: 1 хп → смерть).
  // Отход раненого и бегство от неравного боя — одна фаза «уход»: переключения между ними рвали сам отход (лаборатория 13.10).
  const phase = t => t ? [t.kind === 'recover' || t.data?.panic ? 'retreat' : '', t.data?.hold, t.data?.fountain, t.data?.ambush && t.kind, t.data?.line !== undefined ? 'line' : '', t.data?.rotation].join('|') : ''
  function preempt(b) {
    const running = b.swarmTask
    if (!b.swarmExecuting || !running || now() - (b.swarmTaskAt || 0) < 1000 || !alive(b.name)) return false
    const { task } = refresh(b)
    if (!task || phase(task) === phase(running)) return false
    b.swarmTask = task; b.swarmTaskAt = now()
    log(`↪ ${b.name}: смена фазы ${running.kind}${running.data?.fountain ? '/' + running.data.fountain : ''} → ${task.kind}${task.data?.fountain ? '/' + task.data.fountain : ''}${task.data?.hold ? '/' + task.data.hold : ''} — обрываю дело`)
    b.c.call('stop').catch(() => {})
    return true
  }
  async function turn(b) {
    const context = refresh(b), { board, member, task } = context
    if (!member || !task) return
    if (board.tasks().some(t => t.status === 'claimed' && t.claim.owner !== b.name && t.participants?.includes(b.name))) return
    if (phase(task) !== phase(b.swarmTask)) b.swarmTaskAt = now()
    b.swarmTask = task
    say(b, task)
    const m = pos[b.name], enemies = board.enemies()
    if (task.kind === 'flee') {
      if (rangedAdvantage(b)) { await b.c.call('fight', { target: task.data.target, targets: enemies.map(e => e.id), allowPlayer: true, allowRanged: true, timeoutSeconds: 3, retreatAtHealth: 8, arena }); return }
      const outcome = detail(await b.c.call('flee', { from: enemies.map(e => e.id), toward: [task.position], timeoutSeconds: 3, safeDist: 14, reason: task.data?.reason, arena }))
      if (outcome.cornered && task.data?.target) {
        log(`⚔ ${b.name}: физически зажат, отвечаю ${task.data.target}`)
        await b.c.call('fight', { target: task.data.target, allowPlayer: true, allowRanged: true, lastStand: true, timeoutSeconds: 3, retreatAtHealth: 0, arena })
      } else if (outcome.mode === 'оторвался') {
        if (outcome.at) m.p = outcome.at
        b.swarmPreparingUntil = now() + 7000
        if (!await loot(b, board) && !await positionStep(b, context, m.inv?.bow ? 'ranged' : 'escape')) await search(b, context)
      }
      return
    }
    const nearest = [...enemies].sort((a, c) => distance(a.position, m.p) - distance(c.position, m.p))[0]
    const gap = nearest ? distance(nearest.position, m.p) : Infinity
    const toward = nearest && gap ? ((nearest.velocity?.x || 0) * (m.p.x - nearest.position.x) + (nearest.velocity?.z || 0) * (m.p.z - nearest.position.z)) / gap * 20 : 0
    const contact = nearest && now() - nearest.seenAt < 1000 && (gap <= 3.5 || toward > 0 && (gap - 3) / toward < .8)
    if (task.kind === 'recover') {
      if (contact) {
        const out = detail(await b.c.call('flee', { from: enemies.map(e => e.id), timeoutSeconds: 3, safeDist: 14, arena }))
        if (out.mode !== 'оторвался') return
      }
      // В кольце и «стаде» место раненого — середина строя: поиск укрытия подальше уводил его из-за щитов (ревью 13.10).
      else if (['ring', 'weak-center'].includes(task.data?.doctrine)) { if (distance(m.p, task.position) > 1) await go(b, task.position, .6) }
      else if (!await positionStep(b, context, 'recover') && distance(m.p, task.position) > 3) await go(b, task.position)
      await b.c.call('eat', { timeoutSeconds: 4 }).catch(() => {})
      return
    }
    if (task.kind === 'heal') {
      if (distance(m.p, task.position) > 4.5) await go(b, task.position, 3)
      await b.c.call('assist', { mode: 'heal', ally: task.data.ally })
      return
    }
    // Стойка на месте: кольцо щитов (щит поднят, лицом наружу), засада флангов или оцепление кокона (присед, взгляд на цель).
    if (task.kind === 'goto' && ['shield', 'ambush', 'cordon'].includes(task.data?.hold)) {
      const range = task.data.range ?? .8
      if (distance(m.p, task.position) > range + .4) { await go(b, task.position, range); return }
      await b.c.call('swarm_hold', { ...(task.data.hold === 'shield' ? { shield: true, face: task.data.face, timeoutSeconds: 4 } : { sneak: true, timeoutSeconds: 2 }),
        enemies: enemies.map(e => e.id), allies: context.members.map(a => a.id), arena })
      return
    }
    // Манёвр приёма (линия, фонтан, засада, кольцо, приманка, оцепление, стройка) важнее ролевых привычек: обмен, сундуки,
    // поиск позиции, маяки и укрытия его не перебивают (разбор 13.10: строитель кокона уходил класть маяк, часовой без лука
    // по 10 с искал позицию для стрельбы).
    const maneuver = !!(task.data?.fountain || task.data?.ambush || task.data?.hold || task.data?.line !== undefined || task.data?.bait || task.data?.cordon || task.data?.buildKind)
    if (!maneuver && !contact && await transfer(b, context)) return
    if (task.data?.buildKind) {
      const enemy = enemies.find(e => e.id === task.data.target), o = task.data.origin
      // Кокон — пока цель в своей клетке; отсечка — пока цель ещё перед стеной (она стоит на её пути, а не вокруг неё).
      const ready = enemy && now() - enemy.seenAt <= 1000 && (task.data.buildKind === 'cutoff'
        ? distance(enemy.position, o) <= 10
        : Math.floor(enemy.position.x) === o.x && Math.floor(enemy.position.z) === o.z && Math.abs(enemy.position.y - o.y) < 1)
      // Строитель работает в шаге от цели, «контакт» его не останавливает: угрозу у клетки проверяет сама кладка (прицел
      // врага, урон) — иначе в 3.5 бл. от цели стройка не шла вовсе, а строитель уходил бродить.
      // Цель в клетке кокона заперта: её тычок сквозь щель — цена, а не повод бросать кладку (swarm_work contained).
      const contained = task.data.buildKind === 'cocoon' && ready ? [task.data.target] : []
      if (ready && await buildStep(b, context, { kind: task.data.buildKind, origin: o, direction: task.data.direction, contained })) return
      // Класть пока нечего (клетки у другого, крыша ждёт стен) — стоять у стройки, а не бродить. Но не в коробке кокона:
      // строитель, доложивший свои клетки, стоял в щели и закрывал телом последнюю клетку крыши (лаборатория 14.10, 22/23).
      const site = { x: o.x + .5, y: o.y, z: o.z + .5 }
      const inBox = task.data.buildKind === 'cocoon' && m.p.y < o.y + 3 && [['x', o.x], ['z', o.z]].every(([k, c]: any) => m.p[k] + .3 > c - 1 && m.p[k] - .3 < c + 2)
      const away = Math.hypot(m.p.x - site.x, m.p.z - site.z)
      if (inBox) await go(b, away > .1 ? { x: site.x + (m.p.x - site.x) / away * 3.2, y: o.y, z: site.z + (m.p.z - site.z) / away * 3.2 } : { x: site.x + 3.2, y: o.y, z: site.z }, .8)
      else if (distance(m.p, site) > 5) await go(b, site, 3)
      else await b.c.call('swarm_hold', { sneak: true, timeoutSeconds: 1, enemies: enemies.map(e => e.id), allies: context.members.map(a => a.id), arena })
      return
    }
    const armed = Object.keys(m.inv || {}).some(n => WEAPON.test(n))
    if (!maneuver && !contact && (task.kind === 'loot' || !armed) && await loot(b, board)) return
    const bow = !!(m.inv?.bow || m.inv?.crossbow) && !!m.inv?.arrow
    if (!maneuver && !contact && (member.role === 'ranged' && bow || member.role === 'miner-builder' || task.data?.sentry && bow) && await positionStep(b, context, member.role === 'miner-builder' ? 'build' : 'ranged')) return
    if (!maneuver && !contact && (task.data?.sentry || b.swarmPosition?.purpose === 'recover') && b.swarmHoldUntil > now()) { await b.c.call('swarm_hold', { sneak: b.swarmPosition?.cover > .5, enemies: enemies.map(e => e.id), allies: context.members.map(a => a.id), timeoutSeconds: 3 }); return }
    if (!maneuver && member.role === 'miner-builder' && !contact && (cooldown.get(`work:${b.name}`) || 0) <= now()) {
      if (nearest && nearest.position.y > m.p.y + 2 && await mineStep(b, context, nearest)) return
      if (b.swarmPosition?.purpose === 'build' && b.swarmPosition.highGround >= 3 && distance(m.p, b.swarmPosition.at) < 2 && await buildStep(b, context, { kind: 'outpost', origin: b.swarmPosition.at })) return
      // Маяк «враг был здесь» — один на клетку, а не на дробную позицию (иначе новый маяк почти каждый ход).
      const trail = nearest && 'trail:' + cellKey({ x: Math.floor(nearest.position.x), y: Math.floor(nearest.position.y), z: Math.floor(nearest.position.z) })
      if (nearest && !board.facts().some(f => f.id === trail) && (m.inv.cobblestone || 0) > 18) {
        const origin = { x: Math.floor(m.p.x) + 1, y: Math.floor(m.p.y), z: Math.floor(m.p.z) }
        if (await buildStep(b, context, { kind: 'beacon', origin })) { board.recordFact(b.name, now(), { id: trail, kind: 'mark', position: nearest.position }, 30000); return }
      }
      if (!task.data.cover && await buildStep(b, context)) return
      if (!nearest && await mineStep(b, context, nearest)) return
    }
    const foe = enemies.find(e => e.id === task.data?.target)
    if (task.kind === 'goto' || task.data?.search) {
      // Охота: дошёл до места, где врага видели последним, — прочёсывать арену, а не стоять.
      if (task.data?.hunt && distance(m.p, task.data.enemyPosition) < 4) { await search(b, context); return }
      await go(b, task.data?.search ? task.data.enemyPosition : task.position, task.data?.range ?? 2)
      if (task.data?.bait && !contact) await b.c.call('eat', { timeoutSeconds: 2 }).catch(() => {})
      return
    }
    if (foe && task.kind === 'fight') {
      b.cur = foe.id
      if (task.data.push && now() - foe.seenAt < 500) {
        const push = detail(await b.c.call('wind_push', { target: foe.id, arena }))
        if (push.fired) return
      }
      const stale = now() - foe.seenAt > 1000, far = distance(m.p, foe.position) > 18 && !rangedAdvantage(b)
      if (stale || !task.data.committed || far) {
        await go(b, stale || task.data.committed && far ? foe.position : task.position, 3)
        return
      }
      // Смыкание фонтана — сперва своё место по кругу (иначе все догоняют его со спины одной кучей), потом удар.
      if (task.data.fountain === 'close' && distance(m.p, task.position) > 1.5 && !contact) { await go(b, task.position, .8); return }
      if (distance(m.p, task.position) > 6 && !contact && !rangedAdvantage(b)) { await go(b, task.position); return }
      if (foe.position.y - m.p.y > 4 && (m.inv.elytra || m.armor?.torso === 'elytra') && m.inv.firework_rocket >= 3 && (cooldown.get(`fly:${b.name}`) || 0) <= now()) {
        cooldown.set(`fly:${b.name}`, now() + 15000)
        await b.c.call('fly_to', { at: foe.position, timeoutSeconds: 15, arena }); return
      }
      const result = detail(await b.c.call('fight', { target: foe.id, targets: enemies.map(e => e.id), relocateTo: home(b), allowPlayer: true, allowRanged: true, timeoutSeconds: task.data.fountain === 'close' ? 4 : 12, retreatAtHealth: 3, roundScope: `${teamOf(b)}:${generation}`, arena }))
      if (result.killed || result.kills?.length) board.noteTacticOutcome(b.name, task.data.doctrine, true)
      // Итог боя в журнал (арена 14.10: убийств почти нет — видно, чем кончается схватка: попадания, хп, причина конца).
      log(`⚔ ${b.name} → ${foe.id}: попаданий ${result.landed ?? '?'}/${result.swings ?? '?'}, хп ${result.hp ?? '?'}${result.killed || result.kills?.length ? ', убил' : ''}${result.stopped || result.why ? ' — ' + String(result.stopped || result.why).slice(0, 70) : ''}`)
      return
    }
    await search(b, context)
  }
  function reset() {
    generation++
    for (const board of boards.values()) board.resetRound()
    for (const b of bots) { delete b.swarmPosition; delete b.swarmHoldUntil; delete b.swarmPreparingUntil; delete b.swarmReserved; delete b.swarmTask; delete b.swarmTaskAt }
    blueprints.clear(); transfers.clear(); planned.clear(); plannedAt.clear(); visited.clear(); cooldown.clear(); placed.clear()
    for (const b of bots) Promise.resolve(b.c?.call('swarm_keep', { clear: true })).catch(() => {})
  }
  const snapshot = () => Object.fromEntries([...boards].map(([team, board]) => [team, { enemies: board.enemies(), tasks: board.tasks(), stats: { ...telemetry }, learning: board.tacticStats() }]))
  // Оценка «не вытяну» — симуляция боя на 600 тиков; на каждый ответ статуса (40 тел — ~160/с) её не пересчитывать: 250 мс.
  const unsafeCache = new Map<string, { at: number; v: boolean }>()
  const unsafe = b => {
    const c = unsafeCache.get(b.name)
    if (c && now() - c.at >= 0 && now() - c.at < 250) return c.v
    // Свежая опасность — сразу, не дожидаясь плана, но по тому же правилу, что в planPvp (mustFlee: смертельный залп,
    // тяжёлая рана, безнадёжный размен), а липкое бегство плана — тоже паника. Раньше здесь была своя личная оценка, и
    // опрос арены рвал бой, который команда держала (арена 14.10).
    const board = boardOf(b), members = membersOf(b), member = members.find(m => m.id === b.name)
    const risk = member && assessSwarmFight(member, board.enemies(), members)
    const contact = !!member && board.enemies().some(e => distance(e.position, member.position) <= 4)
    const v = !rangedAdvantage(b) && !!member && (!!risk && mustFlee(board, member, risk, contact) || planned.get(teamOf(b))?.get(b.name)?.kind === 'flee')
    unsafeCache.set(b.name, { at: now(), v }); return v
  }
  const panic = b => unsafe(b) && !(b.swarmPreparingUntil > now() && boardOf(b).enemies().every(e => distance(e.position, pos[b.name].p) >= 14 && e.threat === 'melee'))
  const canEngage = (b, target) => boardOf(b).enemies().some(e => e.id === target) && !unsafe(b)
  const guardedTurn = async b => { if (b.swarmReserved) return; b.swarmExecuting = true; try { await turn(b) } finally { delete b.swarmExecuting } }
  return { observe, turn: guardedTurn, release, reset, snapshot, panic, canEngage, enemies: b => boardOf(b).enemies() }
}
