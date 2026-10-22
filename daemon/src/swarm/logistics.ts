// Рой (swarm.ts): передачи вещей между своими и чертежи построек (задачи с зависимостями, клетка строителю).
import type { SwarmMember, SwarmTask, Blueprint, BlueprintCell, ClaimedTask } from './types'
import { type SwarmBoard, liveMembers } from './board'
import { validPosition, cellKey, distance, count, ownedCount } from './common'

// canTransfer — пара на паузе (драйвер: отказ передачи — 30 с) пропускается до сортировки: иначе тот же донор назначался
// снова, а другой не получал передачи (Codex 15.10).
export function planTransfers(board: SwarmBoard, members: SwarmMember[], canTransfer?: (donor: SwarmMember, recipient: SwarmMember, item: string) => boolean): SwarmTask[] {
  board.setMembers(members)
  const team = liveMembers(board, members)
  const existing = board.tasks().filter(t => t.kind === 'transfer')
  const active = existing.filter(task => {
    if (task.status === 'claimed') return true
    const d = task.data!
    const donor = team.find(m => m.id === d.donor); const recipient = team.find(m => m.id === d.recipient)
    // Подтверждённый обмен держит обоих, пока снимки рюкзаков не сойдутся, но не дольше 10 с: выстрел или подобранный
    // лут меняют рюкзак раньше снимка, и пара иначе оставалась «занятой» до конца раунда (ревью 13.10).
    if (task.status === 'done' && donor && recipient && board.now() - (task.doneAt ?? board.now()) < 10000 && (count(donor.inventory, d.item) > d.donorBefore - d.count || ownedCount(recipient, d.item) < (d.recipientBeforeOwned ?? d.recipientBefore) + d.count)) return true
    board.cancel(task.id); return false
  })
  const busy = new Set(active.flatMap(t => t.participants || []))
  const candidates: { donor: SwarmMember; recipient: SwarmMember; item: string; amount: number; cost: number }[] = []
  // Жемчуг — каждому по одному (пользователь 21.10: «нашёл жемчуги — говорит всем, каждому по одному, каждый закидывает
  // на самый верх»): у кого лишний (больше своего одного), тот раздаёт тем, у кого нет ни одного.
  const spare = (m: SwarmMember, item: string) => count(m.inventory, item) - Math.max(count(m.reserve, item), count(m.needs, item))
  const pearlShare = team.some(m => spare(m, 'ender_pearl') > 0)
  const needOf = (m: SwarmMember, item: string) => item === 'ender_pearl' && pearlShare ? Math.max(1, count(m.needs, item)) : count(m.needs, item)
  for (const recipient of team) for (const item of new Set([...Object.keys(recipient.needs || {}), ...(pearlShare ? ['ender_pearl'] : [])])) {
    const deficit = needOf(recipient, item) - count(recipient.inventory, item)
    if (deficit <= 0) continue
    for (const donor of team) {
      if (donor === recipient || canTransfer?.(donor, recipient, item) === false) continue
      const reserve = Math.max(count(donor.reserve, item), count(donor.needs, item))
      const surplus = count(donor.inventory, item) - reserve
      const amount = Math.min(surplus, deficit)
      if (amount > 0) candidates.push({ donor, recipient, item, amount, cost: distance(donor.position, recipient.position) / amount })
    }
  }
  candidates.sort((a, b) => a.cost - b.cost || a.recipient.id.localeCompare(b.recipient.id) || a.item.localeCompare(b.item))
  const planned: SwarmTask[] = [...active]
  for (const c of candidates) {
    if (busy.has(c.donor.id) || busy.has(c.recipient.id)) continue
    const task = board.upsert({ id: `transfer:${c.donor.id}:${c.recipient.id}:${c.item}`, kind: 'transfer', assignedTo: c.donor.id, participants: [c.donor.id, c.recipient.id], priority: 70, position: c.recipient.position, data: { donor: c.donor.id, recipient: c.recipient.id, item: c.item, count: c.amount, reserve: Math.max(count(c.donor.reserve, c.item), count(c.donor.needs, c.item)), donorBefore: count(c.donor.inventory, c.item), recipientBefore: count(c.recipient.inventory, c.item), recipientBeforeOwned: ownedCount(c.recipient, c.item) } })
    planned.push(task); busy.add(c.donor.id); busy.add(c.recipient.id)
  }
  return planned
}

export function addBlueprint(board: SwarmBoard, blueprint: Blueprint): SwarmTask[] {
  if (!blueprint.id || !Array.isArray(blueprint.cells)) throw new Error('Invalid blueprint')
  const cells = new Map<string, BlueprintCell>()
  const positions = new Set<string>()
  for (const c of blueprint.cells) {
    if (!c.id || cells.has(c.id) || !c.block || !validPosition(c.position) || ![c.position.x, c.position.y, c.position.z].every(Number.isInteger) || positions.has(cellKey(c.position)) || (c.support && typeof c.support !== 'string' && (!validPosition(c.support) || distance(c.position, c.support) !== 1))) throw new Error('Invalid/duplicate blueprint cell or support')
    cells.set(c.id, c); positions.add(cellKey(c.position))
  }
  const visiting = new Set<string>(); const visited = new Set<string>()
  const dependencies = (c: BlueprintCell) => [...new Set([...(c.dependsOn || []), ...(typeof c.support === 'string' ? [c.support] : [])])]
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('Blueprint dependency cycle')
    if (visited.has(id)) return
    const c = cells.get(id); if (!c) throw new Error('Unknown blueprint dependency')
    visiting.add(id)
    for (const dep of dependencies(c)) visit(dep)
    if (typeof c.support === 'string' && distance(c.position, cells.get(c.support)!.position) !== 1) throw new Error('Blueprint support must be adjacent')
    visiting.delete(id); visited.add(id)
  }
  for (const id of cells.keys()) visit(id)
  const prefix = `build:${blueprint.id}:`
  for (const old of board.tasks().filter(t => t.kind === 'build' && t.id.startsWith(prefix))) {
    const c = cells.get(old.data?.cell)
    if (!c || cellKey(c.position) !== cellKey(old.position!) || c.block !== old.data?.block) throw new Error('Cannot replace an active blueprint')
  }
  const occupied = board.tasks().filter(t => t.kind === 'build' && !t.id.startsWith(prefix))
  if (blueprint.cells.some(c => occupied.some(t => cellKey(t.position!) === cellKey(c.position)))) throw new Error('Blueprint cell belongs to another task')
  return blueprint.cells.map(c => board.upsert({ id: prefix + c.id, kind: 'build', priority: Number.isFinite(c.priority) ? c.priority : 60, position: c.position, dependsOn: dependencies(c).map(id => prefix + id), data: { blueprint: blueprint.id, cell: c.id, block: c.block, ...(c.support && typeof c.support !== 'string' ? { supportPosition: c.support } : {}) } }))
}

// blueprint — только клетки этого чертежа: строитель кокона не уходит класть чужой маяк или укрытие (ревью 13.10).
export function nextBuild(board: SwarmBoard, member: SwarmMember, leaseMs = 3000, blueprint?: string): ClaimedTask | null {
  if (member.team !== board.team || member.health <= 0) return null
  const cells = board.tasks().filter(t => t.kind === 'build' && t.status === 'pending' && (!blueprint || t.data?.blueprint === blueprint)).sort((a, b) => (b.priority || 0) - (a.priority || 0) || distance(member.position, a.position!) - distance(member.position, b.position!) || a.id.localeCompare(b.id))
  for (const cell of cells) { const claimed = board.claim(cell.id, member.id, leaseMs); if (claimed) return claimed }
  return null
}
