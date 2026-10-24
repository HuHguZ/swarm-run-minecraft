// Рой (swarm.ts): общая доска команды — свои, задачи с арендой, общее зрение, факты, выученные приёмы — и память плана
// боя по доске (fledAt, pvpMemory): владелец — этот модуль, очищает их resetRound.
import type { SwarmMember, SwarmTask, SharedEnemy, SwarmFact, Doctrine, ClaimedTask, SwarmReceipt, EnemyObservation } from './types'
import type { SwarmTeamFight } from './fight'
import type { Retreat } from './retreat'
import { validPosition, position, cellKey, copy, doctrines, kinds, threats, roles } from './common'
import { createHpEstimate, FOOD, POTION, MAX_HP } from '../pvp/hp-estimate'
import { absorptionOfAmp, TOTEM } from '../pvp/damage-model'

const regenAmp = Math.max(...Object.values(FOOD).map(f => f.regenAmp), ...Object.values(POTION).map(p => 'regenAmp' in p ? p.regenAmp : 0))
const absorptionMax = Math.max(TOTEM.absorption, ...Object.values(FOOD).map(f => absorptionOfAmp(f.absorbAmp)))
const upperModel = (upper: number, absorption = 0) => {
  const hp = createHpEstimate({ hp: Math.min(MAX_HP, upper), absorption: Math.max(absorption, upper - MAX_HP) })
  // Не знаем остаток его эффектов/насыщения: верх стареет по самой быстрой обычной регенерации из данных игры.
  hp.regen(regenAmp, Infinity)
  return hp
}

export class SwarmBoard {
  private members = new Map<string, SwarmMember>()
  private work = new Map<string, SwarmTask>()
  private sightings = new Map<string, Map<string, Omit<SharedEnemy, 'sources'>>>()
  private hpHealing = new Map<string, { at: number; absorption: number; events: Map<string, number> }>()
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
      state?.retreats.delete(id)
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
  dislodging(target: string, method: string): boolean {
    this.prune()
    for (const t of this.work.values()) if (t.status !== 'done' && t.data?.target === target &&
      (method === 'shove' ? t.data.shove : `dig:${t.data.dig}` === method)) return true
    return false
  }
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
    if (!this.alive(source) || input.visible !== true && input.nametag !== true || !input.id || this.members.has(input.id) || !validPosition(input.position) || !Number.isFinite(seenAt) || seenAt > now || seenAt + this.enemyTtlMs <= now) return false
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
    const proof = input.hitProof
    if (proof && Number.isFinite(proof.healed) && proof.healed >= 0 && Array.isArray(proof.hits) && proof.hits.length <= 128 &&
      (!proof.healing || Number.isFinite(proof.healing.event) && Number.isFinite(proof.healing.ago) && proof.healing.ago >= 0 && Number.isFinite(proof.healing.absorption) && proof.healing.absorption >= 0 && proof.healing.absorption <= absorptionMax) &&
      proof.hits.every(h => Number.isFinite(h.ago) && h.ago >= 0 && h.ago <= 8000 && Number.isFinite(h.damage) && h.damage >= 0 && h.damage <= 1000 && Number.isFinite(h.lowDamage) && h.lowDamage >= 0 && h.lowDamage <= h.damage && (h.minDamage === undefined || Number.isFinite(h.minDamage) && h.minDamage >= 0 && h.minDamage <= h.damage) && Number.isFinite(h.healed) && h.healed >= 0 && h.healed <= proof.healed)) seen.hitProof = copy(proof)
    const sources = this.sightings.get(input.id) ?? new Map()
    // Ник сквозь стену (swarm-senses): место свежее, а снаряжение и угроза — из последнего прямого наблюдения.
    if (input.nametag === true) {
      const last = [...sources.values()].sort((a, b) => b.seenAt - a.seenAt)[0]
      if (last?.equipment) seen.equipment = last.equipment
      if (last?.threat) seen.threat = last.threat
      if (last?.hpEstimate) seen.hpEstimate = last.hpEstimate
    }
    if ((sources.get(source)?.seenAt ?? -Infinity) > seenAt) return false
    sources.set(source, seen); this.sightings.set(input.id, sources)
    if (seen.hitProof?.healing) {
      const heal = seen.hitProof.healing, previous = this.hpHealing.get(input.id)
      const events = previous?.events ?? new Map<string, number>()
      // seenAt — начало RPC, ago — возраст в конце RPC. Барьер по приёму не принимает старый удар за новый при разном RTT.
      if (events.get(source) !== heal.event) {
        events.set(source, heal.event)
        this.hpHealing.set(input.id, { at: now, absorption: Math.max(previous?.absorption ?? 0, heal.absorption), events })
      }
    }
    return true
  }
  enemies(): SharedEnemy[] {
    this.prune()
    const now = this.now()
    return [...this.sightings.values()].map(sources => {
      const list = [...sources.values()]
      const fresh = copy(list.sort((a, b) => b.seenAt - a.seenAt)[0])
      const heal = this.hpHealing.get(fresh.id)
      if (heal) {
        // Зритель мог пропустить лечение и снова прислать старые 3 с новым seenAt. Его модель уже не верх.
        // Возвращаемся к консервативному потолку; новые собственные damage_event после лечения снова его снижают.
        const hp = upperModel(MAX_HP, heal.absorption)
        let cursor = Math.max(heal.at, now - 8000)
        const hits = list.flatMap(o => (o.hitProof?.hits || []).map(h => ({ at: o.seenAt - h.ago, min: h.minDamage })))
          .filter(h => h.min !== undefined && h.at > heal.at && h.at >= cursor && h.at <= now).sort((a, b) => a.at - b.at)
        for (const hit of hits) {
          hp.tick((hit.at - cursor) / 50, { visible: false })
          hp.hit({ min: hit.min!, max: hit.min! })
          cursor = hit.at
        }
        hp.tick((now - cursor) / 50, { visible: false })
        // В jar еда и Regeneration лечат до 1 дискретно; фазы обоих таймеров нам неизвестны.
        if (now > heal.at) hp.heal(0, 2)
        fresh.hpEstimate = hp.snapshot().hi
      } else {
        const hps = list.filter(o => Number.isFinite(o.hpEstimate)).map(o => {
          const hp = upperModel(o.hpEstimate!)
          hp.tick((now - o.seenAt) / 50, { visible: false })
          if (now > o.seenAt) hp.heal(0, 2)
          return hp.snapshot().hi
        })
        if (hps.length) fresh.hpEstimate = Math.min(...hps); else delete fresh.hpEstimate
      }
      // У каждого тела — только свои удары. Лечение наблюдают все: берём максимум, не умножаем реген на размер роя.
      const proofs = list.filter(o => o.hitProof).map(o => {
        const hits = o.hitProof!.hits.filter(h => h.ago + this.now() - o.seenAt <= 8000)
        const damage = hits.reduce((s, h) => s + h.damage, 0)
        return { hits: hits.length, damage, damageLow: hits.reduce((s, h) => s + h.lowDamage, 0), healing: hits.length ? Math.max(0, o.hitProof!.healed - hits[0].healed) : 0 }
      })
      const pressure = { hits: proofs.reduce((s, p) => s + p.hits, 0), damage: proofs.reduce((s, p) => s + p.damage, 0), damageLow: proofs.reduce((s, p) => s + p.damageLow, 0), healing: Math.max(0, ...proofs.map(p => p.healing)) }
      return { ...fresh, pressure, sources: [...sources.keys()].sort() }
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
  resetRound(): void { this.work.clear(); this.sightings.clear(); this.hpHealing.clear(); this.marks.clear(); this.members.clear(); this.known.clear(); this.current = null; this.teamFight = null; this.assault = null; this.assaultEnded = null; fledAt.delete(this); pvpMemory.delete(this) }
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
  // Начатые отходы (retreat.ts): держатся, пока мир их не кончит.
  retreats: Map<string, Retreat>
  // Сильное меньшинство (race.ts strongFew): последняя оценка, пока врагов не видно.
  strongFew?: boolean
  // Урон подтверждённых ударов не окупает лечение: у смертельного края — подкоп и цепь толчков.
  dislodge?: boolean
  // Лечение, перевесившее подтверждённый урон: выход требует перекрыть его чистым уроном, а не пересечь ноль окна.
  dislodgeEvidence?: Map<string, number>
  // Бюджет попытки — по оставшейся работе; неудача временно повышает её цену, новый раунд очищает память.
  dislodgeWork?: Map<string, { at: number; active: boolean; failed: boolean; work: number; alternative: number; deadline: number; penalty: number; penaltyAt: number; dug?: number; progressAt?: number }>
  // Всё оружие, что видели у врага за раунд (в руке бывает лук, а меч — в хотбаре): человек помнит, чем его били.
  arsenal: Map<string, Set<string>>
  // Эпизод схватки (doctrine.ts): с первого контакта до пропажи врагов из виду — обманки выключены.
  brawl?: boolean
  // Ранг линии на смене (doctrine.lineDuty).
  lineDuty?: number
}
export const pvpMemory = new WeakMap<SwarmBoard, PvpMemory>()
export function pvpState(board: SwarmBoard) {
  if (!pvpMemory.has(board)) pvpMemory.set(board, { failed: new Map(), equipment: new Map(), retreats: new Map(), arsenal: new Map() })
  return pvpMemory.get(board)!
}
// Враги доски с памятью их снаряжения за раунд: пропуск поля не доказывает, что враг снял прежнюю броню или чары (15.10).
// Один взгляд для плана и мгновенной паники драйвера: паника считала по сырым врагам, и «залп» мигал против плана
// (стенд 15×15, 21.10: 184 «⚡ залп» за раунд при задании плана goto/recover).
export function knownEnemies(board: SwarmBoard): SharedEnemy[] {
  const state = pvpState(board)
  return board.enemies().map(e => {
    const equipment = { ...state.equipment.get(e.id), ...e.equipment }
    if (e.equipment?.armor && e.equipment.unknownArmorSlots === undefined) delete equipment.unknownArmorSlots
    state.equipment.set(e.id, copy(equipment))
    if (equipment.weapon) state.arsenal.set(e.id, (state.arsenal.get(e.id) || new Set()).add(equipment.weapon))
    return { ...e, equipment }
  })
}
