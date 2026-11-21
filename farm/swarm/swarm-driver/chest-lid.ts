import { cellKey, distance, underArrowFire } from './common'
import { currentTurn } from './lifecycle'
import { approachingChest, lidMaterial } from '../../../daemon/src/chest-lid'
import type { SwarmDriverCtx, TurnCtx } from './common'

const valuable = /^(?:diamond|netherite)_(?:helmet|chestplate|leggings|boots|sword|axe|spear)$|^(?:mace|trident|elytra|totem_of_undying|enchanted_golden_apple)$/
type Cell = { x: number; y: number; z: number }
type Lid = { item?: string; pending?: boolean; at?: Cell; partner?: Cell | null }
// A physical cover survives a refill. The team map is replaced on round reset.
const covered = new WeakMap<object, Map<string, Lid>>()

export async function chestLidTurn(sw: SwarmDriverCtx, { b, task, round, m, enemies, board, context }: TurnCtx) {
  const memory = sw.knownChests?.get(sw.teamOf(b))
  const recentlyHurt = m?.hurtTick > 0 && Number.isFinite(m.tick) && m.tick - m.hurtTick <= 20
  if (!memory?.size || !m?.p || m.rescuing || m.water || m.tactics?.action || underArrowFire(b, sw.now()) ||
      /^(flee|recover|heal|transfer)$/.test(task.kind) || task.data?.panic || task.data?.risk?.lethal || task.data?.commanded || task.data?.finishing ||
      recentlyHurt || task.kind === 'fight' && (m.hp ?? 20) < 14) return false
  const team = context.members || [], now = sw.now(), near = enemies.filter(e => now - e.seenAt < 1500)
  const records = covered.get(memory)
  if (!near.length && !records?.size) return false
  let waitingForCover = false
  for (const id of (near.length ? memory : records!).keys()) {
    const chest = memory.get(id)
    if (!chest) continue
    const peer = chest.partner && 'chest:' + cellKey(chest.partner)
    const record: Lid = records?.get(id) || (peer && records?.get(peer)) || {}, report = chest.report, opening = !!record.item
    if (!opening && chest.slots === 54 && !peer) continue
    const at = record.at || { ...chest.at, y: chest.at.y + 1 }, center = { x: at.x + .5, y: at.y - .5, z: at.z + .5 }
    if (distance(center, m.p) > 4.5) continue
    const base = { ...at, y: at.y - 1 }, recordId = 'chest:' + cellKey(base)
    const partner = record.at ? record.partner : chest.partner
    const halves = partner ? [base, partner] : [base]
    const ids = halves.map(p => 'chest:' + cellKey(p))
    if (record.pending) { waitingForCover = true; continue }
    if (opening && ids.some(key => sw.fullFor.get(b.name + ':' + key) === JSON.stringify(m.inv || {}))) continue
    // In block-interaction range the rival can open on their next input while our loot route is unsafe.
    const rival = near.map(e => board.visualSighting(e.id, b.name)).find(e => e && now - e.seenAt < 1500 &&
      distance(e.position, center) <= 5 && approachingChest(e.position, e.velocity, center))
    if (opening ? !sw.lootSafe(b, center) || near.some(e => distance(e.position, center) < 14) :
      !rival || sw.lootSafe(b, center) || !report || now - report.time > 45000 || !report.items.some(n => valuable.test(n))) continue
    const others = sw.bots.filter(o => o !== b && sw.alive(o.name) && sw.teamOf(o) === sw.teamOf(b))
    if (others.some(o => {
      const action = o.last
      if (action?.m === 'chest_take' && action.pending !== false) {
        return [action.p, action.p?.at].some(p => p && ids.includes('chest:' + cellKey(p)))
      }
      if (opening) return false
      const plan = o.swarmTask, to = plan?.position, from = sw.pos[o.name]?.p
      // A priced loot route names the chest. An ordinary loot assignment carries a formation point.
      return plan?.kind === 'loot' && plan.data?.lootTier > 0 && to && from &&
        halves.some(h => h.x === Math.floor(to.x) && h.y === Math.floor(to.y) && h.z === Math.floor(to.z)) &&
        distance(from, center) < distance(rival.position, center)
    })) continue
    const item = record.item || lidMaterial(m.inv, rival.equipment?.weapon, team.filter(a => distance(a.position, center) <= 5))
    if (!item) continue
    const tasks = board.tasks().filter(t => ids.includes(t.id))
    if (tasks.some(t => t.claim)) continue
    const retryKey = `chestLid:${b.name}:${recordId}`, timeoutSeconds = opening ? 12 : 1
    const signature = [report?.time, opening, item, ...['x', 'y', 'z'].map(k => Math.floor(m.p[k] * 4)), rival?.id,
      ...(rival ? ['x', 'y', 'z'].map(k => Math.floor(rival.position[k])) : [])].join('|')
    if (sw.blocked(b, retryKey, signature)) continue
    // Both public work keys address the same window. Reserve them before the first await.
    for (const [i, key] of ids.entries()) {
      if (tasks.find(t => t.id === key)?.status === 'done') board.cancel(key)
      board.upsert({ id: key, kind: 'scout', position: halves[i], data: { loot: true } })
    }
    const lease = opening ? 16000 : 3000
    const claims = partner ? board.claimChestPair(ids[0], ids[1], b.name, lease) : [board.claim(recordId, b.name, lease)].filter(Boolean)
    if (!claims.length) continue
    const lids = records || new Map<string, Lid>()
    const pending: Lid = { ...record, at, partner, pending: true }
    const owner = b.swarmTurnOwner
    try {
      covered.set(memory, lids); lids.set(recordId, pending)
      const raw = await b.c.call('swarm_work', { kind: opening ? 'dig' : 'place', at, item, chestLid: true,
        ...(partner ? { chestPartner: partner } : {}), ...(rival ? { rival: { id: rival.id, at: rival.position, velocity: rival.velocity } } : {}), allies: team.map(a => a.id), timeoutSeconds, arena: sw.arena }).catch(() => null)
      if (round !== sw.generation) return true
      const r = raw?.detail || raw
      if (r?.done && r.ok && r.at && cellKey(r.at) === cellKey(at) && (opening ? /^(air|cave_air|void_air)$/.test(r.after) : !r.already && r.after === item)) {
        if (opening) lids.delete(recordId); else lids.set(recordId, { item, at, partner })
        sw.cleared(retryKey)
        sw.log(`📦 ${b.name}: ${opening ? 'снял' : 'поставил'} блок ${item} над ${ids[0]}`)
        // A safe return includes the transfer. Keep the window leases through the actual chest receipt.
        const body = sw.pos[b.name]
        if (opening && raw?.status === 'done' && currentTurn(sw, b, round) && b.swarmTurnOwner === owner && b.swarmTask === task &&
            body?.p && distance(body.p, center) <= 4.5 && !body.rescuing && !body.water && !body.tactics?.action && !sw.commandOwnsMovement?.(b) &&
            memory.get(recordId)?.report?.items.some(n => valuable.test(n))) await sw.loot(b, board, true, claims)
        return true
      }
      if (!currentTurn(sw, b, round)) return true
      if (opening && r?.why === 'lid_changed') lids.delete(recordId)
      else if (opening && r?.why === 'lid_pair_changed') lids.set(recordId, { ...record, partner: r.partner || null })
      else if (!r?.aborted || r.why === 'direct_threat') sw.failed(b, retryKey, signature, sw.now() + timeoutSeconds * 1000)
      return false
    } finally {
      if (lids.get(recordId) === pending) { if (record.item) lids.set(recordId, record); else lids.delete(recordId) }
      for (const claim of claims) board.release(claim.id, b.name, claim.claim.token)
    }
  }
  return waitingForCover && !near.length
}
