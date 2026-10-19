// Рой (swarm.ts): общая доска команды — свои, задачи с арендой, общее зрение, факты, выученные приёмы — и память плана
// боя по доске (fledAt, pvpMemory): владелец — этот модуль, очищает их resetRound.
import type { SwarmMember, SwarmTask, SharedEnemy, SwarmFact, Doctrine, ClaimedTask, SwarmReceipt, EnemyObservation } from './types'
import type { SwarmTeamFight } from './fight'
import { validPosition, position, cellKey, copy, doctrines, kinds, threats, roles } from './common'

export class SwarmBoard {
  private members = new Map<string, SwarmMember>()
  private work = new Map<string, SwarmTask>()
  private sightings = new Map<string, Map<string, Omit<SharedEnemy, 'sources'>>>()
  private marks = new Map<string, SwarmFact>()
  private learned: Partial<Record<Doctrine, { successes: number; failures: number }>> = {}
  // Кто был в команде за раунд: исход приёма засчитывается и погибшему (его уже нет среди живых — ревью 13.10).
  private known = new Set<string>()
  // Приём, который команда сейчас ведёт, и с какого момента (гистерезис выбора).
  private current: { doctrine: Doctrine; since: number } | null = null
  // Последний командный счёт боя (planPvp): драйвер пишет в журнал, когда решение «держим бой» меняется.
  teamFight: SwarmTeamFight | null = null
  // Штурм держится до исхода в мире; часы — только для журнала (15.10).
  assault: { since: number; target: string; voters: string[]; startAlive: number } | null = null
  assaultEnded: { at: number; why: string; lost: number; target: string; seconds: number } | null = null
  private token = 0
  constructor(readonly team: string, readonly now: () => number = Date.now, readonly enemyTtlMs = 3000) {
    if (!team || !Number.isFinite(enemyTtlMs) || enemyTtlMs <= 0) throw new Error('Invalid swarm team/TTL')
  }
  setMembers(members: SwarmMember[]): void {
    const next = new Map<string, SwarmMember>()
    for (const m of members) {
      if (m.team !== this.team) continue
      if (!m.id || next.has(m.id) || !validPosition(m.position) || !Number.isFinite(m.health) || !Number.isFinite(m.strength) || m.strength < 0 || !roles.includes(m.role) || (m.maxHealth !== undefined && (!Number.isFinite(m.maxHealth) || m.maxHealth <= 0)) || (m.offHand !== undefined && typeof m.offHand !== 'string') || [m.inventory, m.reserve, m.needs].some(items => items && Object.values(items).some(n => !Number.isFinite(n) || n < 0))) throw new Error('Invalid swarm member')
      next.set(m.id, copy(m)); this.known.add(m.id)
    }
    // Уход и смерть снимают fledAt; возврат не стирает потери штурма (15.10).
    for (const id of this.members.keys()) if (!next.has(id) || next.get(id)!.health <= 0) {
      this.releaseOwner(id); fledAt.get(this)?.delete(id)
      const state = pvpMemory.get(this)
      if (state?.assault?.roster.has(id)) state.assault.lost.add(id)
    }
    this.members = next
    for (const task of this.work.values()) if ((task.assignedTo && !this.alive(task.assignedTo)) || task.participants?.some(id => !this.alive(id))) this.work.delete(task.id)
  }
  alive(id: string): boolean { return (this.members.get(id)?.health ?? 0) > 0 }
  private prune(): void {
    const now = this.now()
    for (const task of this.work.values()) {
      if (task.expiresAt !== undefined && task.expiresAt <= now) { this.work.delete(task.id); continue }
      if (task.claim && task.claim.expiresAt <= now) { delete task.claim; task.status = 'pending' }
    }
    for (const [id, sources] of this.sightings) {
      for (const [source, seen] of sources) if (seen.seenAt + this.enemyTtlMs <= now) sources.delete(source)
      if (!sources.size) this.sightings.delete(id)
    }
    for (const [id, fact] of this.marks) if (fact.expiresAt <= now) this.marks.delete(id)
  }
  upsert(input: SwarmTask): SwarmTask {
    this.prune()
    if (!input.id || !kinds.includes(input.kind) || (input.team !== undefined && input.team !== this.team) || (input.position && !validPosition(input.position)) || (input.expiresAt !== undefined && !Number.isFinite(input.expiresAt)) || [input.dependsOn, input.participants].some(ids => ids && (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id))) || (input.kind === 'build' && (!input.position || typeof input.data?.block !== 'string' || !input.data.block || (input.data.supportPosition && !validPosition(input.data.supportPosition))))) throw new Error('Invalid swarm task')
    const task = copy(input)
    task.team = this.team
    delete task.claim
    task.status = 'pending'
    const old = this.work.get(task.id)
    if (old) {
      const prior = { ...old, status: 'pending' }; delete prior.claim
      if (JSON.stringify(prior) === JSON.stringify(task)) return copy(old)
    }
    this.work.set(task.id, task)
    return copy(task)
  }
  tasks(): SwarmTask[] { this.prune(); return [...this.work.values()].map(copy) }
  cancel(id: string): boolean { return this.work.delete(id) }
  releaseOwner(owner: string): void {
    for (const task of this.work.values()) if (task.claim && (task.claim.owner === owner || task.participants?.includes(owner))) { delete task.claim; task.status = 'pending' }
  }
  release(id: string, owner: string, token: number): boolean {
    this.prune()
    const task = this.work.get(id)
    if (task?.claim?.owner !== owner || task.claim.token !== token) return false
    delete task.claim; task.status = 'pending'; return true
  }
  claim(id: string, owner: string, leaseMs = 3000): ClaimedTask | null {
    this.prune()
    const task = this.work.get(id)
    if (!this.alive(owner) || !task || task.status === 'done' || task.claim || (task.assignedTo && task.assignedTo !== owner) || !Number.isFinite(leaseMs) || leaseMs <= 0) return null
    if (task.dependsOn?.some(id => this.work.get(id)?.status !== 'done')) return null
    const participants = new Set([owner, ...(task.participants || [])])
    if ([...participants].some(id => !this.alive(id))) return null
    for (const other of this.work.values()) if (other.claim && ([other.claim.owner, ...(other.participants || [])].some(id => participants.has(id)) || (['build', 'mine'].includes(task.kind) && ['build', 'mine'].includes(other.kind) && task.position && other.position && cellKey(task.position) === cellKey(other.position)))) return null
    if (task.kind === 'build' && task.data?.supportPosition && !this.facts().some(f => f.kind === 'support' && cellKey(f.position) === cellKey(task.data!.supportPosition))) return null
    task.claim = { owner, token: ++this.token, claimedAt: this.now(), expiresAt: Math.min(this.now() + leaseMs, task.expiresAt ?? Infinity) }
    task.status = 'claimed'
    return copy(task) as ClaimedTask
  }
  renew(id: string, owner: string, token: number, leaseMs = 3000): boolean {
    this.prune()
    const task = this.work.get(id)
    if (task?.claim?.owner !== owner || task.claim.token !== token || !this.alive(owner) || !Number.isFinite(leaseMs) || leaseMs <= 0) return false
    task.claim.expiresAt = Math.min(this.now() + leaseMs, task.expiresAt ?? Infinity)
    return true
  }
  ack(id: string, owner: string, receipt: SwarmReceipt): boolean {
    this.prune()
    const task = this.work.get(id)
    if (!receipt.confirmed || task?.claim?.owner !== owner || task.claim.token !== receipt.token || !this.alive(owner)) return false
    if (task.kind === 'build' && (!receipt.position || !validPosition(receipt.position) || cellKey(receipt.position) !== cellKey(task.position!) || receipt.block !== task.data?.block)) return false
    task.status = 'done'; task.doneAt = this.now(); delete task.claim
    return true
  }
  observe(source: string, seenAt: number, input: EnemyObservation): boolean {
    const now = this.now()
    if (!this.alive(source) || input.visible !== true || !input.id || this.members.has(input.id) || !validPosition(input.position) || !Number.isFinite(seenAt) || seenAt > now || seenAt + this.enemyTtlMs <= now) return false
    const seen: Omit<SharedEnemy, 'sources'> = { id: input.id, position: position(input.position), seenAt, source }
    if (input.velocity && validPosition(input.velocity)) seen.velocity = position(input.velocity)
    if (input.equipment) {
      seen.equipment = {}
      if (typeof input.equipment.weapon === 'string') seen.equipment.weapon = input.equipment.weapon
      if (Array.isArray(input.equipment.armor)) seen.equipment.armor = input.equipment.armor.filter(n => typeof n === 'string' && /_(helmet|chestplate|leggings|boots)$/.test(n)).slice(0, 4)
      if (typeof input.equipment.enchanted === 'boolean') seen.equipment.enchanted = input.equipment.enchanted
      if (Number.isInteger(input.equipment.unknownArmorSlots) && input.equipment.unknownArmorSlots! >= 0 && input.equipment.unknownArmorSlots! <= 4) seen.equipment.unknownArmorSlots = input.equipment.unknownArmorSlots
    }
    if (input.threat && threats.includes(input.threat)) seen.threat = input.threat
    if (Number.isFinite(input.hpEstimate) && input.hpEstimate! > 0 && input.hpEstimate! <= 40) seen.hpEstimate = input.hpEstimate
    const sources = this.sightings.get(input.id) ?? new Map()
    if ((sources.get(source)?.seenAt ?? -Infinity) > seenAt) return false
    sources.set(source, seen); this.sightings.set(input.id, sources)
    return true
  }
  enemies(): SharedEnemy[] {
    this.prune()
    // Хп — наименьший верх среди источников: каждый знает только свои попадания, и любой верх — честная граница.
    return [...this.sightings.values()].map(sources => {
      const list = [...sources.values()], hps = list.map(o => o.hpEstimate).filter((n): n is number => Number.isFinite(n))
      const fresh = copy(list.sort((a, b) => b.seenAt - a.seenAt)[0])
      if (hps.length) fresh.hpEstimate = Math.min(...hps); else delete fresh.hpEstimate
      return { ...fresh, sources: [...sources.keys()].sort() }
    }).sort((a, b) => a.id.localeCompare(b.id))
  }
  recordFact(source: string, seenAt: number, fact: Pick<SwarmFact, 'id' | 'kind' | 'position' | 'threat'>, ttlMs = 3000): boolean {
    if (!this.alive(source) || !fact.id || !['mark', 'support', 'threat'].includes(fact.kind) || !validPosition(fact.position) || !Number.isFinite(seenAt) || seenAt > this.now() || !Number.isFinite(ttlMs) || ttlMs <= 0 || seenAt + ttlMs <= this.now()) return false
    const prior = this.marks.get(fact.id)
    if (prior && prior.seenAt > seenAt) return false
    this.marks.set(fact.id, { id: fact.id, kind: fact.kind, position: position(fact.position), threat: fact.threat && threats.includes(fact.threat) ? fact.threat : undefined, source, seenAt, expiresAt: seenAt + ttlMs })
    return true
  }
  facts(): SwarmFact[] { this.prune(); return [...this.marks.values()].map(copy) }
  noteTacticOutcome(source: string, doctrine: Doctrine, success: boolean): boolean {
    if (!this.known.has(source) || !doctrines.includes(doctrine) || typeof success !== 'boolean') return false
    const stats = this.learned[doctrine] ??= { successes: 0, failures: 0 }
    if (success) stats.successes++; else stats.failures++
    return true
  }
  tacticStats(): Partial<Record<Doctrine, { successes: number; failures: number }>> { return copy(this.learned) }
  doctrineState(): { doctrine: Doctrine; since: number } | null { return this.current ? { ...this.current } : null }
  setDoctrine(doctrine: Doctrine): void { if (this.current?.doctrine !== doctrine) this.current = { doctrine, since: this.now() } }
  resetRound(): void { this.work.clear(); this.sightings.clear(); this.marks.clear(); this.members.clear(); this.known.clear(); this.current = null; this.teamFight = null; this.assault = null; this.assaultEnded = null; fledAt.delete(this); pvpMemory.delete(this) }
}

export function liveMembers(board: SwarmBoard, members: SwarmMember[]) { return members.filter(m => m.team === board.team && m.health > 0) }

// Слабый убегал и ещё не вернулся к луту за 22 бл. (порог возврата — 22, а не 16). Без срока: режим меняет дистанция, а не
// время (пользователь 15.10: «не режим бега на N секунд — отбежал на такую-то дистанцию, тогда меняй режим»).
export const fledAt = new WeakMap<SwarmBoard, Map<string, number>>()
export const markFled = (board: SwarmBoard, id: string) => { if (!fledAt.has(board)) fledAt.set(board, new Map()); fledAt.get(board)!.set(id, board.now()) }
export type AssaultBalance = { ready: number; attack: number; armor: number; tough: number; prot: number; hp: number; force: number; enchanted: boolean; voters?: string[] }
// Память штурма без TTL; новый раунд очищает её (15.10).
export type PvpMemory = {
  failed: Map<string, AssaultBalance>
  equipment: Map<string, NonNullable<SharedEnemy['equipment']>>
  assault?: { balance: AssaultBalance; roster: Set<string>; lost: Set<string>; lostAtHit: number; hp: number }
}
export const pvpMemory = new WeakMap<SwarmBoard, PvpMemory>()
export function pvpState(board: SwarmBoard) {
  if (!pvpMemory.has(board)) pvpMemory.set(board, { failed: new Map(), equipment: new Map() })
  return pvpMemory.get(board)!
}
