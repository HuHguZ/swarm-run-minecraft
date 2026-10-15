// Общая доска команды: факты из союзного зрения, задачи и аренда исполнения существующими RPC.
import { aimingAt } from './pvp/crowd'
const damage = require('./pvp/damage-model')

export type SwarmPosition = { x: number; y: number; z: number }
export type SwarmRole = 'fighter' | 'healer' | 'ranged' | 'flank' | 'miner-builder'
export type SwarmKind = 'fight' | 'goto' | 'heal' | 'build' | 'mine' | 'scout' | 'recover' | 'transfer' | 'flee' | 'loot'
export type Doctrine = 'ring' | 'line' | 'buffalo' | 'fountain' | 'weak-center' | 'cocoon' | 'wave' | 'hunt' | 'false-weakness' | 'false-retreat'
export type ThreatKind = 'melee' | 'bow' | 'aerial' | 'blast'
export interface SwarmMember {
  id: string
  team: string
  position: SwarmPosition
  health: number
  maxHealth?: number
  strength: number
  role: SwarmRole
  canHeal?: boolean
  inventory?: Record<string, number>
  reserve?: Record<string, number>
  needs?: Record<string, number>
  armor?: string[] | Record<string, string>
  /** Предмет в левой руке (щит, тотем): в рюкзаке его нет. */
  offHand?: string
  weapon?: string
  ench?: { sharpness?: number; protection?: number; power?: number }
}
export interface EnemyObservation {
  id: string
  visible: boolean
  position: SwarmPosition
  velocity?: SwarmPosition
  equipment?: { weapon?: string; armor?: string[]; enchanted?: boolean; unknownArmorSlots?: number }
  threat?: ThreatKind
  // Верх оценки его хп (с поглощением) по нашим подтверждённым попаданиям и видимому лечению — не метаданные (AGENTS.md):
  // своё имя, а не hp/health, — сырое хп доска не читает никогда (тесты честности).
  hpEstimate?: number
}
export interface SharedEnemy extends Omit<EnemyObservation, 'visible'> {
  seenAt: number
  source: string
  sources: string[]
}
export interface SwarmFact {
  id: string
  kind: 'mark' | 'support' | 'threat'
  position: SwarmPosition
  threat?: ThreatKind
  source: string
  seenAt: number
  expiresAt: number
}
export interface SwarmTask {
  id: string
  kind: SwarmKind
  team?: string
  priority?: number
  position?: SwarmPosition
  assignedTo?: string
  participants?: string[]
  dependsOn?: string[]
  expiresAt?: number
  data?: Record<string, any>
  status?: 'pending' | 'claimed' | 'done'
  claim?: { owner: string; token: number; claimedAt: number; expiresAt: number }
  /** Когда подтверждена (ack). */
  doneAt?: number
}
export type ClaimedTask = SwarmTask & { claim: NonNullable<SwarmTask['claim']> }
export interface SwarmReceipt { token: number; confirmed: boolean; position?: SwarmPosition; block?: string }
export interface BlueprintCell { id: string; position: SwarmPosition; block: string; dependsOn?: string[]; support?: string | SwarmPosition; /** Порядок кладки: выше — раньше (умолчание 60). */ priority?: number }
export interface Blueprint { id: string; cells: BlueprintCell[] }

const distance = (a: SwarmPosition, b: SwarmPosition) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
const validPosition = (p: SwarmPosition) => p && [p.x, p.y, p.z].every(Number.isFinite)
const position = (p: SwarmPosition): SwarmPosition => ({ x: p.x, y: p.y, z: p.z })
const cellKey = (p: SwarmPosition) => `${p.x},${p.y},${p.z}`
const ratio = (m: SwarmMember) => Math.min(1, Math.max(0, m.health / (m.maxHealth ?? 20)))
const copy = <T>(value: T): T => structuredClone(value)
const count = (items: Record<string, number> | undefined, item: string) => Math.max(0, Math.floor(items?.[item] || 0))
export function ownedCount(member: Pick<SwarmMember, 'inventory' | 'armor'>, item: string): number {
  return count(member.inventory, item) + (Array.isArray(member.armor) ? member.armor : Object.values(member.armor || {})).filter(name => name === item).length
}
const doctrines: Doctrine[] = ['ring', 'line', 'buffalo', 'fountain', 'weak-center', 'cocoon', 'wave', 'hunt', 'false-weakness', 'false-retreat']
const kinds: SwarmKind[] = ['fight', 'goto', 'heal', 'build', 'mine', 'scout', 'recover', 'transfer', 'flee', 'loot']
const threats: ThreatKind[] = ['melee', 'bow', 'aerial', 'blast']
const roles: SwarmRole[] = ['fighter', 'healer', 'ranged', 'flank', 'miner-builder']
const sharpWeapon = (name?: string) => !!name && /_(sword|axe|spear)$/.test(name)
const hasShield = (m: SwarmMember) => count(m.inventory, 'shield') > 0 || m.offHand === 'shield'
const buildBlock = (m: SwarmMember) => Object.entries(m.inventory || {}).find(([n, c]) => /^(cobblestone|stone|dirt|sandstone|smooth_sandstone|netherrack|.*_planks)$/.test(n) && c > 0)?.[0]

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

function liveMembers(board: SwarmBoard, members: SwarmMember[]) { return members.filter(m => m.team === board.team && m.health > 0) }
// Та же шкала снаряжения, что power в ферме; неизвестное здоровье — консервативные 20, не HP из сущности.
function visibleForce(enemy: SharedEnemy): number {
  const tier = (name: string) => /netherite/.test(name) ? 4 : /diamond/.test(name) ? 3 : /iron/.test(name) ? 2 : /stone|chainmail|copper/.test(name) ? 1 : 0
  const weapon = enemy.equipment?.weapon
  const armed = weapon && /_sword|_axe|_spear|mace|trident|bow|crossbow/.test(weapon) ? tier(weapon) + 2 : 0
  const armor = (enemy.equipment?.armor || []).reduce((sum, name) => sum + tier(name) + 2, 0) + (enemy.equipment?.unknownArmorSlots || 0) * 6
  return 20 * (1 + armed / 4) * (1 + armor / 18)
}
export interface SwarmFightRisk {
  unsafe: boolean
  target?: string
  killSeconds: number
  survivalSeconds: number
  damage: number
  ready: number
  contactSlots: number
  enemySharpness: [number, number]
  enemyProtection: [number, number]
  // Первый залп убивает раньше, чем убьём мы: бежать при любом размене сторон.
  lethal?: boolean
  reason: string
}
function ownDefense(m: SwarmMember) {
  const defense = damage.defenseOf((Array.isArray(m.armor) ? m.armor : Object.values(m.armor || {})).filter(Boolean).map(name => ({ name })))
  defense.prot = Math.max(0, m.ench?.protection || 0)
  return defense
}
function enemyDefense(e: SharedEnemy) {
  // Блеск виден, тип и уровень чар нет: верх — vanilla Protection IV, низ ноль (блеск может быть от иных чар).
  const armor = (e.equipment?.armor || []).map(name => ({ name, ench: { protection: e.equipment?.enchanted ? 4 : 0 } }))
  const unknown = Math.max(0, Math.min(4 - armor.length, e.equipment?.unknownArmorSlots || 0))
  const slots = ['chestplate', 'leggings', 'helmet', 'boots'].filter(slot => !armor.some(it => it.name.endsWith('_' + slot)))
  for (const slot of slots.slice(0, unknown)) armor.push({ name: 'netherite_' + slot, ench: { protection: 4 } })
  return damage.defenseOf(armor)
}
function combatProfile(m: SwarmMember, foe: SharedEnemy) {
  const defense = enemyDefense(foe)
  const weapons = [...new Set([m.weapon, ...Object.keys(m.inventory || {}).filter(n => count(m.inventory, n) > 0 && damage.isMeleeWeapon(n)), null])]
  let best: any = null
  for (const weapon of weapons) {
    if (weapon && !damage.isMeleeWeapon(weapon)) continue
    // Крит — то же правило, что у врага (enemyAttack): оружие ближнего боя с полным зарядом — крит, кулак — нет. Доля
    // критов у ботов ниже (бой лаборатории 14.10: 1 из 9), но решение сравнивает стороны: одно правило сдвигает время
    // убийства и выживания одинаково, а «свои всегда критуют» давало перекос в свою пользу.
    const raw = damage.meleeRaw({ weapon, sharpness: m.ench?.sharpness || 0, crit: damage.isMeleeWeapon(weapon) })
    const interval = Math.max(damage.IFRAME_TICKS, damage.ticksToCharge(weapon))
    const hit = damage.afterDefense(raw, 'melee', defense)
    const candidate = { member: m, defense: ownDefense(m), raw, kind: 'melee', interval, hit, ranged: false }
    if (!best || hit / interval > best.hit / best.interval) best = candidate
  }
  if (m.inventory?.arrow && (m.inventory.bow || m.inventory.crossbow)) {
    const bow = !!m.inventory.bow
    const speed = damage.arrowSpeedAt(bow ? 3 : damage.CROSSBOW_ARROW_SPEED, distance(m.position, foe.position))
    const outcomes = damage.arrowOutcomes({ speed, power: m.ench?.power || 0, crit: true })
    const raw = outcomes.reduce((s: number, o: { raw: number; p: number }) => s + o.raw * o.p, 0)
    const interval = bow ? damage.BOW_FULL_TICKS : damage.crossbowChargeTicks()
    const hit = damage.afterDefense(raw, 'projectile', defense)
    if (distance(m.position, foe.position) <= 32 && (!best || hit / interval > best.hit / best.interval)) best = { member: m, defense: ownDefense(m), raw, kind: 'projectile', interval, hit, ranged: true }
  }
  return best
}
function enemyAttack(e: SharedEnemy, m: SwarmMember) {
  const weapon = e.equipment?.weapon
  const glint = !!e.equipment?.enchanted
  let raw: number; let kind = 'melee'; let interval: number
  if (e.threat === 'blast' || /^(end_crystal|respawn_anchor)$/.test(weapon || '')) {
    kind = 'explosion'
    raw = damage.explosionRaw({ power: weapon === 'respawn_anchor' ? damage.ANCHOR_POWER : damage.CRYSTAL_POWER, dist: distance(e.position, m.position), seen: 1 })
    interval = damage.IFRAME_TICKS
  } else if (/^(bow|crossbow)$/.test(weapon || '')) {
    kind = 'projectile'
    const outcomes = damage.arrowOutcomes({ speed: damage.arrowSpeedAt(weapon === 'bow' ? 3 : damage.CROSSBOW_ARROW_SPEED, distance(e.position, m.position)), power: glint && weapon === 'bow' ? 5 : 0, crit: true })
    raw = Math.max(...outcomes.map((o: { raw: number }) => o.raw))
    interval = weapon === 'bow' ? damage.BOW_FULL_TICKS : damage.crossbowChargeTicks(glint ? 3 : 0)
  } else {
    raw = damage.meleeRaw({ weapon, sharpness: glint && sharpWeapon(weapon) ? 5 : 0, crit: damage.isMeleeWeapon(weapon) || (e.velocity?.y || 0) < 0, fall: weapon === 'mace' && (e.velocity?.y || 0) < 0 ? Math.max(0, e.position.y - m.position.y) : 0, density: glint ? 5 : 0 })
    interval = Math.max(damage.IFRAME_TICKS, damage.ticksToCharge(weapon))
  }
  const radial = e.velocity ? Math.max(0, (e.velocity.x * (m.position.x - e.position.x) + e.velocity.z * (m.position.z - e.position.z)) / Math.max(0.1, Math.hypot(m.position.x - e.position.x, m.position.z - e.position.z)) * 20) : 0
  const arrival = kind === 'projectile' ? distance(e.position, m.position) / ((weapon === 'crossbow' ? damage.CROSSBOW_ARROW_SPEED : 3) * 20) : kind === 'explosion' ? 0 : Math.max(0, distance(e.position, m.position) - 3) / Math.max(5.6, radial)
  return { raw, kind, interval, arrival: Math.ceil(arrival * 20), breach: glint && weapon === 'mace' ? 4 : 0 }
}
// Pure event simulation: full-charge hits, armor/enchantment reduction and the shared 10-tick player hit window.
export function assessSwarmFight(member: SwarmMember, enemies: SharedEnemy[], members: SwarmMember[]): SwarmFightRisk {
  const foe = [...enemies].sort((a, b) => distance(a.position, member.position) - distance(b.position, member.position))[0]
  if (!foe) return { unsafe: false, killSeconds: 0, survivalSeconds: Infinity, damage: 0, ready: 0, contactSlots: 0, enemySharpness: [0, 0], enemyProtection: [0, 0], reason: 'нет видимой угрозы' }
  const incoming = enemies.map(e => ({ enemy: e, ...enemyAttack(e, member) }))
  const defense = ownDefense(member)
  const incomingHits = incoming.map(e => damage.afterDefense(e.raw, e.kind, defense, { breach: e.breach }))
  const incomingDps = Math.min(incoming.reduce((s, e, i) => s + incomingHits[i] * 20 / e.interval, 0), Math.max(...incomingHits) * 20 / damage.IFRAME_TICKS)
  const firstTick = Math.min(...incoming.map(e => e.arrival)), firstArrival = firstTick / 20
  let initialHit = 0, openingLast: any = null, openingTick = firstTick
  // Simultaneous attackers share the victim's hurt window; later stronger hits only add the raw difference.
  for (const attack of [...incoming].sort((a, b) => a.arrival - b.arrival)) {
    if (attack.arrival >= firstTick + damage.IFRAME_TICKS) break
    if (openingLast) openingLast = { ...openingLast, ago: openingLast.ago + attack.arrival - openingTick }
    const hit = damage.throughIframes(attack.raw, openingLast)
    openingLast = hit.last; openingTick = attack.arrival
    initialHit += damage.afterDefense(hit.raw, attack.kind, defense, { breach: attack.breach })
  }
  const exposure = firstArrival + member.health / Math.max(0.1, incomingDps)
  const profiles = members.filter(m => m.team === member.team && m.health > 0).map(m => {
    const profile = combatProfile(m, foe)
    return { ...profile, arrival: Math.ceil(profile.ranged ? distance(m.position, foe.position) / 3 : Math.max(0, distance(m.position, foe.position) - 3) / 5.6 * 20) }
  // Помощник — кто успеет добежать, как и враг: цель на общей доске знает весь рой. Требование «видит сам» оставляло
  // в счёте 2 своих против всех 3–5 врагов арены, и бежали обе команды (арена 14.10: 0 убийств; у Codex — 40 ботов, 6 мин).
  }).filter(a => a.member.id === member.id || a.arrival / 20 <= exposure)
  const mine = profiles.find(a => a.member.id === member.id) || { ...combatProfile(member, foe), arrival: 0 }
  const helpers = profiles.filter(a => a.member.id !== member.id).sort((a, b) => b.hit / b.interval - a.hit / a.interval || a.arrival - b.arrival)
  const melee = [mine, ...helpers.filter(a => !a.ranged)].filter(a => !a.ranged).slice(0, 2)
  const attackers = [...melee, ...[mine, ...helpers].filter(a => a.ranged).slice(0, 2)]
  const actors = attackers.map((a, i) => ({ ...a, hp: a.member.health, next: a.arrival + i * damage.IFRAME_TICKS, last: null as any }))
  const foeDefense = enemyDefense(foe)
  let enemyHp = foe.hpEstimate ?? 20; let foeLast: any = null; let survival = Infinity; let kill = Infinity
  const nextIncoming = incoming.map(a => a.arrival)
  const ticks = 600
  for (let tick = 0; tick <= ticks && enemyHp > 0 && actors.some(a => a.hp > 0); tick++) {
    if (foeLast) foeLast = { ...foeLast, ago: foeLast.ago + 1 }
    for (const a of actors) if (a.last) a.last = { ...a.last, ago: a.last.ago + 1 }
    for (const [i, attack] of incoming.entries()) {
      if (tick < nextIncoming[i]) continue
      nextIncoming[i] += attack.interval
      const focus = actors.find(a => a.member.id === member.id && a.hp > 0) || actors.find(a => a.hp > 0)
      if (!focus) break
      const victims = attack.kind === 'explosion' ? actors.filter(a => a.hp > 0) : [focus]
      for (const victim of victims) {
        const raw = attack.kind === 'explosion' ? enemyAttack(attack.enemy, victim.member).raw : attack.raw
        const hit = damage.throughIframes(raw, victim.last)
        victim.last = hit.last
        victim.hp -= damage.afterDefense(hit.raw, attack.kind, victim.defense, { breach: attack.breach })
        if (victim.member.id === member.id && victim.hp <= 0 && survival === Infinity) survival = tick / 20
      }
    }
    for (const a of actors) {
      if (a.hp <= 0 || tick < a.next) continue
      a.next += a.interval
      const hit = damage.throughIframes(a.raw, foeLast)
      foeLast = hit.last
      enemyHp -= damage.afterDefense(hit.raw, a.kind, foeDefense)
      if (enemyHp <= 0) { kill = tick / 20; break }
    }
  }
  const period = Math.max(...incoming.map(e => e.interval)) / 20
  const nominalDps = Math.max(0.01, ...actors.map(a => a.hit * 20 / a.interval))
  const baseKill = Number.isFinite(kill) ? kill : Math.min(...actors.map(a => a.arrival)) / 20 + (foe.hpEstimate ?? 20) / nominalDps
  const survivalSeconds = Number.isFinite(survival) ? survival : firstArrival + member.health / Math.max(0.01, incomingDps)
  const localEnemies = incoming.filter(e => e.arrival / 20 <= Math.min(baseKill, survivalSeconds)).length
  const killSeconds = baseKill * Math.max(1, localEnemies / Math.max(1, profiles.length))
  const myActor = actors.find(a => a.member.id === member.id)
  const loss = myActor ? Math.max(0, member.health - Math.max(0, myActor.hp)) : initialHit
  // Зеркально убийству: нас больше — враг бьёт нас по очереди, раненый уходит в середину, его место занимает свежий
  // (арена 14.10: шестеро бежали от одного — «убить 12.6 с, выжить 10.2 с, готово 6, врагов 1»). В счёт — только те,
  // чей удар ранит цель (от полусердца после брони): голые против незерита — не смена, а потери.
  const able = profiles.filter(a => a.hit >= 1).length
  const teamSurvival = survivalSeconds * Math.max(1, able / Math.max(1, localEnemies))
  const lethal = initialHit >= member.health && firstArrival <= killSeconds
  const unsafe = killSeconds > teamSurvival + period || lethal
  const slots = foe.equipment?.armor?.length || 0
  const protectionUpper = (foe.equipment?.enchanted ? slots * 4 : 0) + Math.min(4 - slots, foe.equipment?.unknownArmorSlots || 0) * 4
  return { unsafe, lethal, target: foe.id, killSeconds, survivalSeconds, damage: loss, ready: profiles.length, contactSlots: melee.length, enemySharpness: foe.equipment?.enchanted && sharpWeapon(foe.equipment.weapon) ? [0, 5] : [0, 0], enemyProtection: [0, protectionUpper], reason: `убить≈${killSeconds.toFixed(1)}с, выжить≈${survivalSeconds.toFixed(1)}с, контакт ${melee.length}, готово ${profiles.length}, врагов ${localEnemies}, хп ${Math.round(member.health)}` }
}
export interface SwarmTeamFight { engage: boolean; ourLoss: number; theirLoss: number; wipedUs: boolean; wipedThem: boolean; seconds: number; ours: number; theirs: number }
// Командный счёт боя (14.10): стороны целиком, а не «выживу ли я, если бьют все». Личная оценка (assessSwarmFight) при
// равных силах — монетка: в ничьей бежали обе команды арены (0 убийств; у Codex — 40 ботов, 6 мин). Здесь каждый бьёт
// ближнего живого противника, не больше двух на одного (так рой и делит цели), удар проходит через окно неуязвимости
// цели, удары тика — одновременно (без форы своим), у врага 20 хп (его хп не видно), подход — по расстоянию. Итог за 30
// игровых с — потери сторон в долях бота (погибший — 1, раненый — доля потерянного).
export function assessTeamFight(team: SwarmMember[], enemies: SharedEnemy[]): Omit<SwarmTeamFight, 'engage'> {
  type Strike = { raw: number; kind: string; interval: number; ranged: boolean; breach: number }
  type Unit = { side: 0 | 1; position: SwarmPosition; hp: number; start: number; defense: any; last: any; target: number; next: number; strike: Strike | null; seen: SharedEnemy }
  // Обе стороны — по одному правилу видимого (enemyDefense/enemyAttack): материал брони, оружие в руке, блеск → чары по
  // максимуму. Свои точные чары против «блеск = максимум» у врага давали обеим командам «проигрываем» (арена 14.10:
  // синие 4.0 : 3.1, красные 3.8 : 2.5 в одном и том же бою). Хп: свои — известные, чужие — верх оценки по нашим
  // попаданиям (e.hpEstimate), без оценки — 20: раненые свои против «свежих» чужих снова давали обеим сторонам «проигрываем».
  const seenOf = (m: SwarmMember): SharedEnemy => ({ id: m.id, position: m.position, velocity: { x: 0, y: 0, z: 0 }, sources: [], seenAt: 0,
    threat: /^(bow|crossbow)$/.test(m.weapon || '') ? 'bow' : 'melee',
    equipment: { weapon: m.weapon ?? null, armor: (Array.isArray(m.armor) ? m.armor : Object.values(m.armor || {})).filter(Boolean) as string[], ...(Object.values(m.ench || {}).some(v => Number(v) > 0) ? { enchanted: true } : {}) } } as any)
  const units: Unit[] = [
    ...team.filter(m => m.health > 0).map(m => { const seen = seenOf(m); return { side: 0 as const, position: m.position, hp: m.health, start: m.health, defense: enemyDefense(seen), last: null, target: -1, next: 0, strike: null, seen } }),
    ...enemies.map(e => ({ side: 1 as const, position: e.position, hp: e.hpEstimate ?? 20, start: e.hpEstimate ?? 20, defense: enemyDefense(e), last: null, target: -1, next: 0, strike: null, seen: e }))
  ]
  const strike = (u: Unit, v: Unit): Strike => {
    const a = enemyAttack(u.seen, { position: v.position } as SwarmMember)
    return { raw: a.raw, kind: a.kind, interval: a.interval, ranged: a.kind !== 'melee', breach: a.breach }
  }
  const load = (i: number) => units.filter(w => w.hp > 0 && w.target === i).length
  const aim = (u: Unit, tick: number) => {
    const foes = units.map((v, i) => i).filter(i => units[i].side !== u.side && units[i].hp > 0)
    if (!foes.length) return false
    const i = foes.sort((a, b) => Number(load(a) >= 2) - Number(load(b) >= 2) || distance(u.position, units[a].position) - distance(u.position, units[b].position))[0]
    const d = distance(u.position, units[i].position)
    u.target = i; u.strike = strike(u, units[i])
    u.next = Math.max(u.next, tick + Math.ceil(u.strike.ranged ? d / 3 : Math.max(0, d - 3) / 5.6 * 20))
    return true
  }
  const alive = (side: 0 | 1) => units.some(u => u.side === side && u.hp > 0)
  let tick = 0
  for (; tick <= 600 && alive(0) && alive(1); tick++) {
    for (const u of units) if (u.last) u.last = { ...u.last, ago: u.last.ago + 1 }
    const hits: Array<[Unit, Unit]> = []
    for (const u of units) {
      if (u.hp <= 0 || (u.target < 0 || units[u.target].hp <= 0) && !aim(u, tick) || tick < u.next) continue
      u.next += u.strike!.interval
      hits.push([u, units[u.target]])
    }
    for (const [u, v] of hits) {
      const victims = u.strike!.kind === 'explosion' ? units.filter(w => w.side !== u.side && w.hp > 0 && distance(w.position, v.position) <= 5) : [v]
      for (const w of victims) {
        const hit = damage.throughIframes(u.strike!.kind === 'explosion' ? enemyAttack(u.seen, { position: w.position } as SwarmMember).raw : u.strike!.raw, w.last)
        w.last = hit.last
        w.hp -= damage.afterDefense(hit.raw, u.strike!.kind, w.defense, { breach: u.strike!.breach })
      }
    }
  }
  const loss = (side: 0 | 1) => units.filter(u => u.side === side).reduce((sum, u) => sum + (u.hp <= 0 ? 1 : (u.start - u.hp) / 20), 0)
  return { ourLoss: loss(0), theirLoss: loss(1), wipedUs: !alive(0), wipedThem: !alive(1), seconds: tick / 20, ours: units.filter(u => u.side === 0).length, theirs: enemies.length }
}
// Группа своих вокруг m: связные в 10 бл. (свой рядом со своим рядом с m).
export function groupOf(team: SwarmMember[], m: SwarmMember): SwarmMember[] {
  const group = [m]
  for (let grew = true; grew;) { grew = false; for (const a of team) if (!group.includes(a) && group.some(g => distance(g.position, a.position) <= 10)) { group.push(a); grew = true } }
  return group
}
// Приговор группы против врагов в 12 бл. от неё (assessTeamFight): futile — пустой размен, больше трёх своих за одного
// врага (десять голых против незерита — тест Codex) или нас выносят, а мы не снимаем с них и четверти (голый одиночка
// против брони); outnumbered — нас выносят, а у них остаётся не меньше тел, чем было нас (один против трёх, трое против
// шести: это не бой роя, а отход к своим). Одна мера для планировщика и для мгновенной паники драйвера.
export function groupVerdict(group: SwarmMember[], enemies: SharedEnemy[]): { futile: boolean; outnumbered: boolean } {
  const foes = enemies.filter(e => group.some(a => distance(a.position, e.position) <= 12))
  if (!foes.length) return { futile: false, outnumbered: false }
  const score = assessTeamFight(group, foes)
  const futile = score.ourLoss > 3 * Math.max(score.theirLoss, .5) || score.wipedUs && score.theirLoss < score.theirs / 4
  return { futile, outnumbered: !futile && score.wipedUs && score.theirs - score.theirLoss >= Math.max(1, score.ours) }
}
// Политика боя (пользователь 14.10: «рои вырезают друг друга, бой должен кончаться; отступать — тактически и быстро на
// хилку»). Бежит только тот, кого первый залп убьёт; тяжело раненый (меньше 35 % хп — сбегать полечиться и назад); чья
// группа в пустом размене (бежать и из рукопашной: там «любой ценой» значит только потери); чья группа проиграла поле
// (отход к своим, но не из рукопашной — contact, враг ближе 4 бл.: начатая схватка — «любой ценой», её смена на бег
// рвала удары, арена 14.10); одиночка, к которому никто не успеет (ready ≤ 1), если убить врага втрое дольше, чем он
// проживёт. В общем бою личная оценка «бьют все меня» — не повод: на арене так бежали при полном хп 447 раз из 910.
// Натиск (aggressive, соло-арена «люди против роя», пользователь 14.10: «не атакуют, бегают тупо по арене»): против людей
// в незерите любой размен «пустой» и любой удар «залп» — рой бежал 438 раз на 55 боёв. Там бегут только на хилку (< 35 %)
// и только не из схватки: contact здесь — враг в 8 бл. (человек со Скоростью II быстрее спринта бота — бегство из
// рукопашной подставляло спину: «убегать не умеют», 9 из 10 смертей — на бегу или за едой у него под носом).
export function mustFlee(m: SwarmMember, risk: Pick<SwarmFightRisk, 'unsafe' | 'lethal' | 'killSeconds' | 'survivalSeconds' | 'ready'>, contact: boolean, verdict: { futile: boolean; outnumbered: boolean }, aggressive = false): boolean {
  if (aggressive) return !contact && !!risk.unsafe && ratio(m) < .35
  return !!risk.lethal || !!risk.unsafe && (ratio(m) < .35 || verdict.futile || !contact && verdict.outnumbered || risk.ready <= 1 && risk.killSeconds > 3 * Math.max(1, risk.survivalSeconds))
}
// Очки приёмов по обстановке. Взрывы и раненые — не жёсткие ворота, а цена (правило гибкости; ревью 13.10: в бою 20 на 20
// кто-то ранен всегда, и «стадо» выбиралось навсегда): фонтан против взрывов почти всегда первый, стадо — по доле раненых.
export function doctrineScores(board: SwarmBoard, members: SwarmMember[]): Record<Doctrine, number> {
  const team = liveMembers(board, members)
  const foes = board.enemies()
  const stats = board.tacticStats()
  const builders = team.filter(m => m.role === 'miner-builder' && Object.entries(m.inventory || {}).some(([n, c]) => /stone|dirt|planks|netherrack/.test(n) && c > 0)).length
  const blocks = team.reduce((sum, m) => sum + Object.entries(m.inventory || {}).filter(([n]) => /stone|dirt|planks|netherrack/.test(n)).reduce((n, [, c]) => n + c, 0), 0)
  const scores: Record<Doctrine, number> = { ring: 0, line: 3, buffalo: team.length >= 4 ? 4 : 0, fountain: 0, 'weak-center': 0, cocoon: 0, wave: 0, hunt: 0, 'false-weakness': 0, 'false-retreat': 0 }
  if (foes.length) {
    const healers = team.filter(m => m.role === 'healer' && m.canHeal).length
    // A defended healing ring competes with terrain/build/push opportunities; merely holding a bow cannot veto them.
    scores.ring = foes.some(e => e.threat === 'bow' || e.threat === 'aerial' || /^(bow|crossbow)$/.test(e.equipment?.weapon || '')) ? 3 + healers + team.filter(m => count(m.inventory, 'shield') > 0).length * .5 : 0
    scores.cocoon = builders * 3 * Math.min(1, blocks / 23) - Math.max(...foes.map(e => Math.hypot(e.velocity?.x || 0, e.velocity?.z || 0))) * 20
    scores.hunt = builders * 2 * Math.min(1, blocks / 10) + team.filter(m => m.role === 'flank').length
    scores.wave = foes.some(e => e.position.y > team[0]?.position.y + 2) ? team.filter(m => count(m.inventory, 'wind_charge') > 0).length * 2 : 0
    scores['false-weakness'] = healers ? 3 + team.filter(m => m.role === 'flank').length : 0
    scores['false-retreat'] = foes.some(e => Math.hypot(e.velocity?.x || 0, e.velocity?.z || 0) > .1) ? team.length * .8 : 0
  }
  if (foes.some(e => e.threat === 'blast' || /end_crystal|respawn_anchor/.test(e.equipment?.weapon || ''))) scores.fountain = 10 + team.length * .8
  const wounded = team.filter(m => ratio(m) < 0.5).length
  if (wounded) scores['weak-center'] = 4 + 12 * wounded / team.length
  for (const name of doctrines) scores[name] += ((stats[name]?.successes ?? 0) - (stats[name]?.failures ?? 0)) / Math.max(1, (stats[name]?.successes ?? 0) + (stats[name]?.failures ?? 0)) * 2
  return scores
}
export function selectDoctrine(board: SwarmBoard, members: SwarmMember[]): Doctrine {
  const scores = doctrineScores(board, members)
  return doctrines.slice().sort((a, b) => scores[b] - scores[a])[0]
}
const PASSIVE: Doctrine[] = ['false-weakness', 'false-retreat', 'cocoon', 'line', 'ring', 'weak-center']
// Гистерезис: начатый приём держится, пока другой не лучше заметно (на 1.5 очка) — иначе строй меняется каждые полсекунды
// от скорости цели и чужих хп (ревью 13.10); через 15 с хватает и простого перевеса.
function keepDoctrine(board: SwarmBoard, members: SwarmMember[], aggressive = false): Doctrine {
  const scores = doctrineScores(board, members)
  // Натиск — без стоячих приёмов: обманки (ложные отход и слабость), кокон (оцепление стоит и не бьёт, пока замуровывают),
  // линии, кольцо щитов, «слабый центр» — против людей это толпа, что стоит или бежит (соло-арена 14.10: «стояли рядом и
  // не били», «стоят толпой на открытом — вырезаю как дурачков»).
  if (aggressive) for (const d of PASSIVE) scores[d] = -Infinity
  const best = doctrines.slice().sort((a, b) => scores[b] - scores[a])[0]
  const cur = board.doctrineState()
  const keep = cur && cur.doctrine !== best && scores[best] - scores[cur.doctrine] < (board.now() - cur.since < 15000 ? 1.5 : 1e-9)
  const chosen = keep ? cur!.doctrine : best
  board.setDoctrine(chosen)
  return chosen
}

// Смена линий: до трёх рангов, ранг на смене меняется каждые 22.5 с; в команде из одного-двух рангов столько же.
const LINE_SHIFT_MS = 22500
const lineRank = (index: number, size: number) => index % Math.max(1, Math.min(3, size))
const lineDuty = (now: number, size: number) => Math.floor(now / LINE_SHIFT_MS) % Math.max(1, Math.min(3, size))
function formation(m: SwarmMember, index: number, team: SwarmMember[], center: SwarmPosition, forward: SwarmPosition, doctrine: Doctrine, now: number): SwarmPosition {
  const side = { x: -forward.z, y: 0, z: forward.x }
  let along = 0; let across = 0
  const rear = m.role === 'healer' || m.role === 'ranged' || m.role === 'miner-builder'
  if (doctrine === 'ring' || doctrine === 'weak-center') {
    const a = index * 2 * Math.PI / Math.max(1, team.length)
    const radius = m.role === 'healer' ? .5 : rear ? 2 : 3
    along = Math.cos(a) * radius; across = Math.sin(a) * radius
  } else if (doctrine === 'buffalo' || doctrine === 'hunt') {
    along = rear ? -5 : m.role === 'flank' ? 7 : 4
    across = m.role === 'flank' ? (team.filter(a => a.role === 'flank').findIndex(a => a.id === m.id) % 2 ? 1 : -1) * 8 : (index - (team.length - 1) / 2) * 2
  } else if (doctrine === 'fountain') {
    along = -4 - (index % 2) * 3; across = (index % 2 ? 1 : -1) * (5 + Math.floor(index / 2) * 3)
  } else if (doctrine === 'cocoon') {
    const a = index * 2 * Math.PI / team.length
    along = Math.cos(a) * 4; across = Math.sin(a) * 4
  } else if (doctrine === 'false-weakness' || doctrine === 'false-retreat') {
    along = -6; across = (index % 2 ? 1 : -1) * (rear ? 2 : 5)
  } else if (doctrine === 'line') {
    const lines = Math.min(3, team.length)
    const depth = (lineRank(index, team.length) - lineDuty(now, team.length) + lines) % lines
    along = 4 - depth * 4; across = (Math.floor(index / lines) - (Math.ceil(team.length / lines) - 1) / 2) * 2
  } else {
    along = rear ? -5 : 4 * ratio(m)
    across = (index - (team.length - 1) / 2) * 2.5
  }
  return { x: center.x + forward.x * along + side.x * across, y: m.position.y, z: center.z + forward.z * along + side.z * across }
}

// Слабый убегал и ещё не вернулся к луту за 22 бл. (порог возврата — 22, а не 16). Без срока: режим меняет дистанция, а не
// время (пользователь 15.10: «не режим бега на N секунд — отбежал на такую-то дистанцию, тогда меняй режим»).
const fledAt = new WeakMap<SwarmBoard, Map<string, number>>()
const markFled = (board: SwarmBoard, id: string) => { if (!fledAt.has(board)) fledAt.set(board, new Map()); fledAt.get(board)!.set(id, board.now()) }
type AssaultBalance = { ready: number; attack: number; armor: number; tough: number; prot: number; hp: number; force: number; enchanted: boolean; voters?: string[] }
// Память штурма без TTL; новый раунд очищает её (15.10).
type PvpMemory = {
  failed: Map<string, AssaultBalance>
  equipment: Map<string, NonNullable<SharedEnemy['equipment']>>
  assault?: { balance: AssaultBalance; roster: Set<string>; lost: Set<string>; lostAtHit: number; hp: number }
}
const pvpMemory = new WeakMap<SwarmBoard, PvpMemory>()
function pvpState(board: SwarmBoard) {
  if (!pvpMemory.has(board)) pvpMemory.set(board, { failed: new Map(), equipment: new Map() })
  return pvpMemory.get(board)!
}
function memberEquipment(m: SwarmMember): NonNullable<SharedEnemy['equipment']> {
  const weapon = [m.weapon, ...Object.keys(m.inventory || {}).filter(n => count(m.inventory, n) > 0 && damage.isMeleeWeapon(n))].filter(Boolean)
    .sort((a, b) => damage.attackDamage(b) - damage.attackDamage(a))[0]
  return { weapon, armor: (Array.isArray(m.armor) ? m.armor : Object.values(m.armor || {})).filter(Boolean) as string[] }
}
// Грубый отбор; видимую грань и опору своих проверяет swarm_work.
export function canDigTrap(p: SwarmPosition, s: any): boolean {
  return Math.abs(p.y - (s.feetY ?? s.y + 1)) <= .6 &&
    (p.x + .3 <= s.x || p.x - .3 >= s.x + 1 || p.z + .3 <= s.z || p.z - .3 >= s.z + 1) &&
    Math.hypot(s.x + .5 - p.x, s.y - p.y - 1.62, s.z + .5 - p.z) <= 4.5
}
export function planPvp(board: SwarmBoard, members: SwarmMember[], options: { doctrine?: Doctrine; quorum?: number; leaseMs?: number; aggressive?: boolean; hideouts?: SwarmPosition[]; perches?: SwarmPosition[]; gather?: { item: string; deficit: number; spot: SwarmPosition }; edgeOf?: (p: SwarmPosition) => { x: number; z: number } | null; digSites?: (p: SwarmPosition) => SwarmPosition[]; campSpots?: SwarmPosition[]; ladderSites?: { key: string; x: number; y: number; z: number; top: number; face: { x: number; z: number } }[] } = {}): Map<string, SwarmTask> {
  board.setMembers(members)
  const team = liveMembers(board, members).sort((a, b) => a.id.localeCompare(b.id))
  const state = pvpState(board)
  // Пропуск поля не доказывает, что враг снял прежнюю броню или чары (15.10).
  const enemies = board.enemies().map(e => {
    const equipment = { ...state.equipment.get(e.id), ...e.equipment }
    if (e.equipment?.armor && e.equipment.unknownArmorSlots === undefined) delete equipment.unknownArmorSlots
    state.equipment.set(e.id, copy(equipment))
    return { ...e, equipment }
  })

  const aggressive = !!options.aggressive
  const doctrine = options.doctrine ?? keepDoctrine(board, team, aggressive)
  if (!doctrines.includes(doctrine)) throw new Error('Invalid doctrine')
  const plan = new Map<string, SwarmTask>()
  if (!team.length) {
    if (board.assault && state.assault) {
      const a = board.assault, episode = state.assault
      board.assaultEnded = { at: board.now(), why: 'проигрываем', lost: episode.roster.size, target: a.target, seconds: Math.round((board.now() - a.since) / 1000) }
      state.failed.set(a.target, { ...episode.balance, hp: episode.hp, voters: a.voters })
      board.assault = null; delete state.assault
    }
    return plan
  }
  const center = { x: team.reduce((s, m) => s + m.position.x, 0) / team.length, y: team.reduce((s, m) => s + m.position.y, 0) / team.length, z: team.reduce((s, m) => s + m.position.z, 0) / team.length }
  const foeCenter = enemies.length ? { x: enemies.reduce((s, e) => s + e.position.x, 0) / enemies.length, z: enemies.reduce((s, e) => s + e.position.z, 0) / enemies.length } : { x: center.x + 1, z: center.z }
  const d = Math.hypot(foeCenter.x - center.x, foeCenter.z - center.z)
  let forward = { x: (foeCenter.x - center.x) / (d || 1), y: 0, z: (foeCenter.z - center.z) / (d || 1) }
  // Враги вокруг строя (кольцо) или строй вокруг врага (кокон) — направление «на врага» вырождается и прыгает каждые
  // полсекунды, а с ним и все места строя (ревью 13.10). Ближе 2 бл. — прежнее направление, пока оно свежее.
  const kept = board.facts().find(f => f.id === 'forward')
  if (d < 2 && kept && Math.hypot(kept.position.x, kept.position.z) > .5) forward = { x: kept.position.x, y: 0, z: kept.position.z }
  else if (d >= 2 && enemies.length && team.length) board.recordFact(team[0].id, board.now(), { id: 'forward', kind: 'mark', position: { ...forward } }, 10000)
  const observers = new Set(enemies.flatMap(e => e.sources.filter(id => board.alive(id))))
  const quorum = options.quorum ?? Math.ceil(team.length / 2)
  if (!Number.isInteger(quorum) || quorum < 1) throw new Error('Invalid swarm quorum')
  // Натиск: цель, которую видит хоть один свой, — общая (доска), ждать второго наблюдателя незачем.
  const committed = observers.size >= quorum || team.length < 3 || !!options.aggressive
  const formationCenter = doctrine === 'cocoon' && enemies[0] ? enemies[0].position : center
  // Смена линий — такт от начала приёма, а не от эпохи (первая смена выпадала через случайные 0–22 с).
  let lineClock = board.now()
  if (doctrine === 'line' && enemies.length && team.length) {
    let start = board.facts().find(f => f.id === 'line-start')
    if (!start) { board.recordFact(team[0].id, board.now(), { id: 'line-start', kind: 'mark', position: { ...center } }, 600000); start = board.facts().find(f => f.id === 'line-start') }
    if (start) lineClock = board.now() - start.seenAt
  }
  const spots = new Map(team.map((m, i) => [m.id, formation(m, i, team, formationCenter, forward, doctrine, lineClock)]))
  const put = (m: SwarmMember, kind: SwarmKind, data: Record<string, any>, at = spots.get(m.id)!) => {
    const alarm = enemies.some(e => e.threat === 'blast') ? 'scatter' : enemies.some(e => e.threat === 'aerial') ? 'above' : enemies.some(e => e.threat === 'bow') ? 'cover' : null
    const task: SwarmTask = { id: `pvp:${m.id}`, kind, assignedTo: m.id, position: at, priority: kind === 'flee' ? 120 : kind === 'recover' ? 100 : kind === 'heal' ? 90 : data.cover ? 80 : 50, data: { ...data, doctrine, role: m.role, committed, alarm } }
    plan.set(m.id, task)
  }
  // Занятые насесты (perchFor): двое на один не летят.
  const perched = new Map<number, number>()
  // Бой держат всей командой (assessTeamFight), если поле остаётся за нами (наших в конце не меньше, чем их) и размен
  // не хуже ровного (наши потери не больше их). Одно поле — мало: девять голых за одного незеритового «выигрывают» поле
  // (тест Codex); один размен — мало: трое против шестерых меняются 3 на 3 и проигрывают поле. Начатый бой держится с
  // запасом в десятую часть всех тел боя (6 на 6 — 1.2 бота): оценка между пересчётами гуляет на бота, и бой мигал
  // «держим / не держим» каждые полсекунды (арена 14.10; в равной мясорубке «у них остался один» — монетка).
  // Приговор каждой группы своих (groupVerdict); остальное — бой: «врага нужно уничтожить любой ценой» (14.10).
  const groups: SwarmMember[][] = []
  for (const m of team) if (!groups.some(g => g.includes(m))) groups.push(groupOf(team, m))
  const groupVictories = new Map<SwarmMember[], Set<string>>()
  const futile = new Set<string>(), outnumbered = new Set<string>()
  // Натиск: размен не считается — группа не бросает бой и не уходит готовиться (бегут только раненые).
  if (!aggressive) for (const group of groups) {
    const verdict = groupVerdict(group, enemies)
    for (const a of group) if (verdict.futile) futile.add(a.id); else if (verdict.outnumbered) outnumbered.add(a.id)
  }
  const hopeless = new Set([...futile, ...outnumbered])
  // Штурм («красная кнопка», пользователь 14.10: «несколько ботов подтверждают — и все идут мочиться до конца; понимают, что
  // проигрывают, — меняется тактика»). Подтверждают готовые: с оружием и бронёй, хп ≥ 60 %, до цели ≤ 40 бл.; набралось
  // max(4, четверть живых) — штурм до результата; потери без снижения оценки хп — отбой (15.10).
  // Повтор — только с лучшей готовностью против того же проваленного состава, другая цель доступна сразу (15.10).
  const tNow = board.now()
  const assaultFoe = enemies.length ? [...enemies].sort((a, b) => distance(a.position, center) - distance(b.position, center))[0] : null
  const votersFor = (foe: SharedEnemy) => team.filter(m => !weak(m) && !outclassed(m, foe) && ratio(m) >= .6 && distance(m.position, foe.position) <= 40)
  const balanceFor = (foe: SharedEnemy, ready: SwarmMember[]): AssaultBalance => {
    const value = { ready: ready.length, attack: 0, armor: 0, tough: 0, prot: 0, hp: foe.hpEstimate ?? state.failed.get(foe.id)?.hp ?? 20, force: visibleForce(foe), enchanted: !!foe.equipment?.enchanted }
    for (const m of ready) {
      const weapon = memberEquipment(m).weapon, defense = ownDefense(m)
      value.attack += damage.meleeRaw({ weapon, sharpness: m.ench?.sharpness || 0, crit: damage.isMeleeWeapon(weapon) }) * 20 / Math.max(damage.IFRAME_TICKS, damage.ticksToCharge(weapon))
      value.armor += defense.armor; value.tough += defense.tough; value.prot += defense.prot
    }
    return value
  }
  // Повтор и после того, как отошедшие подлечились: все выжившие из проваленного штурма снова с хп ≥ 90 % (пользователь 14.10:
  // «рои добивают друг друга до конца, отходят только ненадолго подлечиться»; стенд 15.10: только «сильнее, чем было» — штурм
  // провален за 16 с, дальше до конца прогона 102 «проигрываем — прячусь»).
  const healed = (old: AssaultBalance) => !!old.voters?.length && old.voters.map(id => team.find(m => m.id === id)).every(m => !m || ratio(m) >= .9)
  const improved = (b: AssaultBalance, old: AssaultBalance) => b.ready > old.ready || b.hp < old.hp || b.force < old.force || old.enchanted && !b.enchanted ||
    b.ready >= old.ready && (b.attack > old.attack || b.armor > old.armor || b.tough > old.tough || b.prot > old.prot) || healed(old)
  let assault = aggressive ? board.assault : null
  if (!aggressive) { board.assault = null; delete state.assault }
  let ended = false
  if (assault && state.assault) {
    const episode = state.assault, foe = enemies.find(e => e.id === assault!.target)
    for (const id of episode.roster) if (!board.alive(id)) episode.lost.add(id)
    const lost = episode.lost.size
    if (foe?.hpEstimate !== undefined) {
      if (foe.hpEstimate < episode.hp) episode.lostAtHit = lost
      episode.hp = foe.hpEstimate
    }
    // Пропажа sightings не доказывает исход; дальнюю цель подтверждает свежий обзор (15.10).
    const outOfReach = foe && tNow - foe.seenAt <= 500 && assault.voters.every(id => !board.alive(id) || distance(team.find(m => m.id === id)!.position, foe.position) > 40)
    // Проигрываем — потери с последнего подтверждённого урона по цели: не меньше трёх и 40 % голосовавших (первая же потеря
    // обрывала штурм за 16 с — стенд 15.10).
    const losing = lost - episode.lostAtHit >= Math.max(3, Math.ceil(assault.voters.length * .4))
    if (losing || outOfReach) {
      board.assaultEnded = { at: tNow, why: losing ? 'проигрываем' : 'вне досягаемости', lost, target: assault.target, seconds: Math.round((tNow - assault.since) / 1000) }
      state.failed.set(assault.target, { ...episode.balance, hp: foe?.hpEstimate ?? episode.hp, voters: assault.voters })
      board.assault = assault = null
      delete state.assault; ended = true
    }
  }
  if (aggressive && !assault) for (const foe of [...enemies].sort((a, b) => distance(a.position, center) - distance(b.position, center))) {
    const ready = votersFor(foe), balance = balanceFor(foe, ready), failed = state.failed.get(foe.id)
    if (ended && board.assaultEnded?.target === foe.id || ready.length < Math.max(4, Math.ceil(team.length / 4)) || failed && !improved(balance, failed)) continue
    board.assault = assault = { since: tNow, target: foe.id, voters: ready.map(m => m.id), startAlive: team.length }
    state.assault = { balance, roster: new Set(team.map(m => m.id)), lost: new Set(), lostAtHit: 0, hp: foe.hpEstimate ?? 20 }
    state.failed.delete(foe.id)
    break
  }
  const regroup = aggressive && !assault && !!assaultFoe && state.failed.has(assaultFoe.id)
  // Проигрываем (пользователь 14.10: «когда понимают, что проигрывают, тупо по карте бегают, хотя могли бы прятаться — капец
  // как легко играть»): штурм провален (перегруппировка) или живых не больше трёх на каждого видимого врага (никого не видно
  // — на одного). Кто не в схватке (враг дальше 6 бл.) и не добивает, — в укрытие (насест на элитрах или место колизея), там
  // на шифте; подошёл ближе — бой, ослаб — ва-банк.
  // Проигрываем — только при видимом враге (Codex 15.10: последние 1–3 без врага прятались, а не лутали).
  const losing = aggressive && !assault && (regroup || enemies.length > 0 && team.length <= 3 * enemies.length)
  // S05: возвращаем 30 с подготовки для проверки регресса на крыше (15.10).
  if (hopeless.size) board.recordFact(team[0].id, board.now(), { id: 'outmatched', kind: 'mark', position: { ...center } }, 30000)
  // Для журнала — счёт всей команды и держит ли бой большинство.
  const score = enemies.length ? assessTeamFight(team, enemies) : null
  board.teamFight = score && { ...score, engage: hopeless.size * 2 < team.length }
  // Ва-банк (пользователь 14.10: «когда мало хп, я начинаю убегать, а они не гонятся добивать — если чувствуют слабость,
  // должны ва-банк идти и добивать»): цель с оценкой хп ≤ 10 (по нашим попаданиям и видимому лечению, не метаданные),
  // виденная за 3 с, — добивание: все, у кого есть оружие, в 32 бл. — прямо на неё; бегства и лечения у них нет, кроме
  // смертельного залпа.
  const prey = aggressive ? enemies.filter(e => (e.hpEstimate ?? 20) <= 10 && board.now() - e.seenAt < 3000).sort((a, b) => (a.hpEstimate ?? 20) - (b.hpEstimate ?? 20))[0] : undefined
  const hunting = (m: SwarmMember) => !!prey && distance(m.position, prey.position) <= 32 && Object.keys(m.inventory || {}).some(n => count(m.inventory, n) > 0 && (damage.isMeleeWeapon(n) || /^(bow|crossbow|trident)$/.test(n)))
  for (const [i, m] of team.entries()) {
    const risk = assessSwarmFight(m, enemies, team)
    if (hunting(m) && !risk.lethal) continue
    // Погоня за слабым или переигранным (стенд rush 15.10: «прячусь» вело в тупик-камеру, он догонял — бой 1–2 удара и смерть):
    // к своим (и слабым — толпа бьёт его со спины) или в отрыв по открытому (smartFlee тела сам обходит тупики); последний
    // бой — только физически зажатым (исполнитель: cornered); оторвался дальше 22 — лут (Codex 15.10).
    const near = aggressive ? [...enemies].sort((a, b) => distance(a.position, m.position) - distance(b.position, m.position))[0] : undefined
    if (near && !weak(m) && outclassed(m, near)) board.recordFact(m.id, board.now(), { id: 'outmatched:' + m.id, kind: 'mark', position: { ...m.position } }, 30000)
    const gap = near ? distance(m.position, near.position) : Infinity
    const v = near?.velocity
    const coming = !!near && board.now() - near.seenAt < 1000 && ((m.position.x - near.position.x) * (v?.x || 0) + (m.position.z - near.position.z) * (v?.z || 0)) / (gap || 1) > .1
    const pursuing = coming || board.tasks().some(t => t.assignedTo === m.id && t.data?.kite && t.data.target === near?.id)
    // Начатая рукопашная не рвётся погоней (в контакте он всегда «идёт на меня»; стенд rush 15.10: fight → flee 66 раз, каждый —
    // stop боя): дерущийся уходит, только когда он дальше 6 бл.
    const prevKind = board.tasks().find(t => t.id === `pvp:${m.id}`)?.kind
    // Лутающий уходит от погони с той же границы 16, что и ветка слабых (Codex 15.10: правило погони с 22 обходило
    // гистерезис 16/22 — «лут ↔ бегство» на 17–22 бл.).
    if (near && gap <= (prevKind === 'loot' ? 16 : 22) && pursuing && !(prevKind === 'fight' && gap <= 6) && (weak(m) || outclassed(m, near))) {
      const perch = perchFor(m), group = !perch && rallyFor(m, near)
      markFled(board, m.id)
      put(m, 'flee', { target: near.id, enemyPosition: near.position, panic: true, ...(perch ? { perch: true } : { kite: true, regroup: !!group }), reason: `ухожу от погони (враг в ${Math.round(gap)} бл.)` }, perch || group || m.position)
      continue
    }
    // S04: возвращаем 3 с паники для проверки регресса на крыше (15.10).
    if (!assault && mustFlee(m, risk, enemies.some(e => distance(e.position, m.position) <= (aggressive ? 8 : 4)), { futile: futile.has(m.id), outnumbered: outnumbered.has(m.id) }, aggressive)) board.recordFact(m.id, board.now(), { id: 'panic:' + m.id, kind: 'mark', position: { ...m.position } }, 3000)
    else if (assault || !board.facts().some(f => f.id === 'panic:' + m.id)) continue
    const threat = enemies.find(e => e.id === risk.target) || [...enemies].sort((a, b) => distance(a.position, m.position) - distance(b.position, m.position))[0]
    if (!threat) continue
    let dx = m.position.x - threat.position.x; let dz = m.position.z - threat.position.z
    if (Math.hypot(dx, dz) < 0.1) { dx = -forward.x; dz = -forward.z }
    const length = Math.hypot(dx, dz) || 1
    const turn = (i - (team.length - 1) / 2) / Math.max(1, team.length) * Math.PI * 0.75
    const x = (dx * Math.cos(turn) - dz * Math.sin(turn)) / length
    const z = (dx * Math.sin(turn) + dz * Math.cos(turn)) / length
    // Перегруппировка: целый, но в безнадёжной местной схватке — бежать к своим, к середине самой большой группы, что не
    // в безнадёжной схватке, а не куда глаза глядят: так группа растёт и бой продолжается (арена 14.10: отход «прочь от
    // угрозы» рассыпал строй, и вместо сбора было 300 бегств при полном хп). Раненый и смертельный залп — прочь, как прежде.
    const home = !risk.lethal && ratio(m) >= .35 ? groups.filter(g => !g.includes(m) && !g.some(a => hopeless.has(a.id))).sort((p, q) => q.length - p.length)[0] : undefined
    const away = { x: m.position.x + x * 12, y: m.position.y, z: m.position.z + z * 12 }
    // Причина бегства — в журнал драйвера (какое условие mustFlee сработало; «держу» — липкая паника без свежего повода).
    const contact = enemies.some(e => distance(e.position, m.position) <= 4)
    const cause = risk.lethal ? 'залп' : !risk.unsafe ? 'держу' : ratio(m) < .35 ? 'рана' : futile.has(m.id) ? 'пустой размен' : !contact && outnumbered.has(m.id) ? 'нас меньше' : risk.ready <= 1 && risk.killSeconds > 3 * Math.max(1, risk.survivalSeconds) ? 'один' : 'держу'
    const perch = perchFor(m)
    put(m, 'flee', { target: threat.id, enemyPosition: threat.position, panic: true, risk, reason: cause + ', ' + risk.reason, ...(perch ? { perch: true } : home ? { regroup: true } : {}) },
      perch ?? (home ? { x: home.reduce((sum, a) => sum + a.position.x, 0) / home.length, y: m.position.y, z: home.reduce((sum, a) => sum + a.position.z, 0) / home.length } : away))
  }
  const hurt = team.filter(m => {
    if (plan.has(m.id)) return false
    // Натиск: у врага под носом не есть и не отходить — добьёт в спину; лечиться — оторвавшись (дальше 8 бл.).
    if (aggressive && (assault || hunting(m) || enemies.some(e => distance(e.position, m.position) <= 8))) return false
    // Врагов не видно — отход только от настоящей раны (< 70 %): царапина от падения не срывает лут (ревью 13.10).
    if (!enemies.length) return ratio(m) < .7
    const nearby = enemies.filter(e => distance(m.position, e.position) < 12).length
    // Кольцо и «стадо» для того и строятся, чтобы раненый ушёл в середину, — там прежний счёт (с 62–70 %).
    if (doctrine === 'ring' || doctrine === 'weak-center') return (1 - ratio(m)) * (8 + nearby * 2) - ratio(m) * 2 > ratio(m) * 4
    // В остальном бою — на хилку с половины хп (больше врагов рядом — чуть раньше, до 60 %), и сразу назад: с 62–70 % бой
    // распадался на отходы (пользователь 14.10: «отступать тактически на хилку быстро»).
    return ratio(m) < .45 + .05 * Math.min(3, nearby)
  }).sort((a, b) => ratio(a) - ratio(b))
  for (const [i, m] of hurt.entries()) {
    const side = (i - (hurt.length - 1) / 2) * 1.5
    // В кольце раненый — в самой середине, за щитами; иначе — за спинами своих.
    const back = doctrine === 'ring' ? 0 : 2
    put(m, 'recover', { ally: m.id }, { x: center.x - forward.x * back - forward.z * side, y: m.position.y, z: center.z - forward.z * back + forward.x * side })
  }
  const healing = new Set<string>()
  for (const healer of team.filter(m => m.role === 'healer' && m.canHeal && !plan.has(m.id))) {
    const ally = team.filter(m => m.id !== healer.id && ratio(m) < 1 && !healing.has(m.id)).sort((a, b) => (1 - ratio(b)) * 20 - distance(healer.position, b.position) - ((1 - ratio(a)) * 20 - distance(healer.position, a.position)))[0]
    if (ally && (1 - ratio(ally)) * 20 > distance(healer.position, ally.position) * 0.3) { healing.add(ally.id); put(healer, 'heal', { ally: ally.id }, ally.position) }
  }
  const loads = new Map(enemies.map(e => [e.id, 0]))
  // Цели, которых сейчас трогать нельзя (замуровываемая в коконе): общий бой их не выбирает.
  const untouchable = new Set<string>()
  const available = team.filter(m => !plan.has(m.id))
  const now = board.now()
  const sideVec = { x: -forward.z, y: 0, z: forward.x }
  const sideOf = (p: SwarmPosition, from: SwarmPosition = center) => (p.x - from.x) * sideVec.x + (p.z - from.z) * sideVec.z
  // Главная цель приёма — ближайшая к своим из свежих (виденных за секунду), а не первая по имени.
  const primary = [...enemies].sort((a, b) => Number(now - a.seenAt > 1000) - Number(now - b.seenAt > 1000) || distance(a.position, center) - distance(b.position, center))[0]
  // Кольцо щитов: кто со щитом и не в ближнем бою, стоит на своём месте кольца лицом наружу с поднятым щитом.
  if (doctrine === 'ring' && primary) for (const m of available) {
    if (plan.has(m.id) || !hasShield(m) || enemies.some(e => now - e.seenAt <= 1000 && distance(e.position, m.position) <= 4.5)) continue
    const spot = spots.get(m.id)!, rx = spot.x - center.x, rz = spot.z - center.z, r = Math.hypot(rx, rz) || 1
    put(m, 'goto', { hold: 'shield', reserve: true, range: .6, target: primary.id, face: { x: spot.x + rx / r * 8, y: spot.y + 1.6, z: spot.z + rz / r * 8 } }, spot)
  }
  if (primary && committed && ['cocoon', 'hunt'].includes(doctrine) && now - primary.seenAt <= 500) {
    // Натиск: строитель рядом с целью (6 бл.) — дерётся, а не кладёт стенку у неё под мечом.
    // Слабый и переигранный стенку у него не кладут (стенд rush 15.10: 6 из 7 первых смертей — строители «загона» у незеритового).
    const builders = available.filter(m => !plan.has(m.id) && m.role === 'miner-builder' && buildBlock(m) && !(aggressive && (assault || distance(m.position, primary.position) <= 6 || weak(m) || outclassed(m, primary))))
    if (builders.length) {
      // Загон впереди бегущей цели (14.10): стенка в 3 бл. от неё не успевала — на спринте (5.6 бл/с) цель пробегала место
      // раньше, чем строители клали клетки (лаборатория, run9 и run12). Бежит — упреждение на 1.5 с пути (3–9 бл.) и стенка
      // поперёк бега; стоит — 3 бл. от неё по направлению строя, как раньше.
      const v = primary.velocity || { x: 0, y: 0, z: 0 }, speed = Math.hypot(v.x, v.z) * 20
      const running = doctrine === 'hunt' && speed > 2.5
      const axis = running ? { x: v.x * 20 / speed, z: v.z * 20 / speed } : { x: forward.x, z: forward.z }
      const offset = doctrine === 'hunt' ? (running ? Math.min(9, Math.max(3, speed * 1.5)) : 3) : 0
      const fresh = { x: Math.floor(primary.position.x + axis.x * offset), y: Math.floor(primary.position.y), z: Math.floor(primary.position.z + axis.z * offset) }
      // Одна стройка на команду: все строители кладут один чертёж (раньше у каждого был свой центр от живой позиции
      // цели, и второй строитель натыкался на чужие клетки — лаборатория 13.10, загон: стену клал один). Новое место —
      // только когда цель ушла: из клетки кокона или дальше 10 бл. от стены загона (и та стена готова или не начата).
      const id = 'build-site:' + doctrine, axisId = 'build-axis:' + doctrine
      let site = board.facts().find(f => f.id === id), siteAxis = board.facts().find(f => f.id === axisId)
      // Цель уже за стенкой загона (по оси стенки дальше 1.5 бл.) — стенка бесполезна и переносится, даже начатая.
      const passed = doctrine === 'hunt' && !!site && !!siteAxis && (primary.position.x - site.position.x - .5) * (siteAxis.position.x - site.position.x) + (primary.position.z - site.position.z - .5) * (siteAxis.position.z - site.position.z) > 1.5
      const gone = !site || (doctrine === 'cocoon'
        ? Math.floor(primary.position.x) !== site.position.x || Math.floor(primary.position.z) !== site.position.z || Math.abs(primary.position.y - site.position.y) > 1
        : passed || distance(primary.position, site.position) > 10 && (() => {
          // Начатую стенку загона достраивают: перенос бросал готовую на 60 % стену ради новой за убегающей целью
          // (лаборатория 14.10: вторую стену клал один строитель). Переносится только готовая или не начатая.
          const cells = board.tasks().filter(t => t.kind === 'build' && t.data?.blueprint === `cutoff:${cellKey(site!.position)}`)
          return !cells.length || cells.every(t => t.status === 'done')
        })())
      // Кокон закладывается только вокруг стоящей цели: в прыжке клетка ног на блок выше, и кокон висел в воздухе (разбор 13.10).
      const standing = doctrine !== 'cocoon' || Math.abs(primary.position.y - Math.round(primary.position.y)) < .05
      if (gone && standing) {
        board.recordFact(builders[0].id, now, { id, kind: 'mark', position: fresh }, 30000)
        board.recordFact(builders[0].id, now, { id: axisId, kind: 'mark', position: { x: fresh.x + axis.x, y: fresh.y, z: fresh.z + axis.z } }, 30000)
        site = board.facts().find(f => f.id === id); siteAxis = board.facts().find(f => f.id === axisId)
      } else if (gone) site = undefined
      // Стенка — поперёк оси, заложенной вместе с местом (не от живого направления строя: оно прыгает за целью).
      const along = site && siteAxis ? { x: siteAxis.position.x - site.position.x, z: siteAxis.position.z - site.position.z } : forward
      const direction = Math.abs(along.x) > Math.abs(along.z) ? along.x > 0 ? 'east' : 'west' : along.z > 0 ? 'south' : 'north'
      if (site) for (const m of builders) put(m, 'scout', { buildKind: doctrine === 'hunt' ? 'cutoff' : 'cocoon', block: buildBlock(m), target: primary.id, enemyPosition: primary.position, origin: site.position, direction })
      // Оцепление кокона: пока стройка не замкнута, остальные не бьют цель (удар — повод вырваться: лаборатория 13.10,
      // цель ушла через щель, пока свои её били) и стоят у выходов — у обеих щелей и по бокам. Замкнут — бьют сквозь щели.
      const inside = site && Math.floor(primary.position.x) === site.position.x && Math.floor(primary.position.z) === site.position.z && Math.abs(primary.position.y - site.position.y) <= 1
      if (doctrine === 'cocoon' && site && inside) {
        const cells = board.tasks().filter(t => t.kind === 'build' && t.data?.blueprint === `cocoon:${cellKey(site.position)}`)
        const sealed = cells.length > 0 && cells.every(t => t.status === 'done')
        if (!sealed) untouchable.add(primary.id)
        const [dx, dz] = ({ east: [1, 0], west: [-1, 0], south: [0, 1], north: [0, -1] } as Record<string, number[]>)[direction]
        const c0 = { x: site.position.x + .5, y: site.position.y, z: site.position.z + .5 }
        const exits = [[dx, dz], [-dx, -dz], [-dz, dx], [dz, -dx]].map(([x, z]) => ({ x: c0.x + x * 2, y: c0.y, z: c0.z + z * 2 }))
        const guards = available.filter(m => !plan.has(m.id))
        for (const at of exits) {
          const g = guards.filter(m => !plan.has(m.id)).sort((a, b) => distance(a.position, at) - distance(b.position, at))[0]
          if (!g) break
          if (sealed) put(g, 'fight', { cordon: true, target: primary.id, enemyPosition: primary.position }, at)
          else put(g, 'goto', { hold: 'cordon', range: .6, target: primary.id, enemyPosition: primary.position }, at)
        }
      }
    }
  }
  if (primary && committed && doctrine === 'false-weakness') {
    // Якорь и ось приёма — на доске с первого плана: середина строя уезжает вперёд за атакующими, и «глубина кармана»
    // от неё срабатывала раньше времени (лаборатория 14.10).
    let anchor = board.facts().find(f => f.id === 'feint-anchor'), axis = board.facts().find(f => f.id === 'feint-axis')
    if (!anchor || !axis) {
      board.recordFact(team[0].id, now, { id: 'feint-anchor', kind: 'mark', position: { ...center } }, 30000)
      board.recordFact(team[0].id, now, { id: 'feint-axis', kind: 'mark', position: { x: center.x + forward.x, y: center.y, z: center.z + forward.z } }, 30000)
      anchor = board.facts().find(f => f.id === 'feint-anchor'); axis = board.facts().find(f => f.id === 'feint-axis')
    }
    const a = anchor?.position ?? center, ax = axis ? { x: axis.position.x - a.x, y: 0, z: axis.position.z - a.z } : forward
    const lat = { x: -ax.z, z: ax.x }, latOf = (p: SwarmPosition) => (p.x - a.x) * lat.x + (p.z - a.z) * lat.z
    const free = available.filter(m => !plan.has(m.id))
    const bait = free.filter(m => m.role !== 'healer' && m.role !== 'flank').sort((p, q) => p.strength - q.strength)[0] ?? free.filter(m => m.role !== 'healer').sort((p, q) => p.strength - q.strength)[0]
    if (bait) put(bait, 'goto', { bait: true, target: primary.id, enemyPosition: primary.position })
    // Засада с двух сторон: по одному флангу на сторону ждут впереди-сбоку «кармана», пока цель гонится за приманкой,
    // и бьют с боков и со спины, когда она прошла их линию (лаборатория 13.10: засады не было вовсе — фланги стояли в строю).
    const flanks = free.filter(m => m !== bait && m.role === 'flank').sort((p, q) => latOf(p.position) - latOf(q.position))
    const depth = (primary.position.x - a.x) * ax.x + (primary.position.z - a.z) * ax.z
    const pair: [SwarmMember, number][] = flanks.length >= 2 ? [[flanks[0], -1], [flanks[flanks.length - 1], 1]] : []
    const sprung = depth <= 3.5 || pair.some(([m]) => distance(m.position, primary.position) <= 4.5)
    for (const [m, sign] of pair) {
      const ambush = { x: a.x + ax.x * 3 + lat.x * sign * 5, y: m.position.y, z: a.z + ax.z * 3 + lat.z * sign * 5 }
      const data = { ambush: sign < 0 ? 'left' : 'right', target: primary.id, enemyPosition: primary.position }
      if (sprung) { put(m, 'fight', data, primary.position); loads.set(primary.id, (loads.get(primary.id) || 0) + 1) }
      else put(m, 'goto', { ...data, hold: 'ambush', range: .8 }, ambush)
    }
    // Остальные изображают слабость вместе с приманкой: стоят за ней, не лезут в драку, пока ловушка не захлопнулась
    // (лаборатория 14.10: бойцы сразу бросились на красных, те ответили, «карман» развалился).
    if (!sprung) for (const [k, m] of free.filter(m => m !== bait && !pair.some(([f]) => f === m) && m.role !== 'healer' && !plan.has(m.id)).entries()) {
      const across = (k % 2 ? 1 : -1) * (1.5 + Math.floor(k / 2) * 1.5)
      put(m, 'goto', { hold: 'ambush', range: .8, feintGuard: true, target: primary.id, enemyPosition: primary.position }, { x: a.x - ax.x * 4 + lat.x * across, y: m.position.y, z: a.z - ax.z * 4 + lat.z * across })
    }
  }
  if (primary && committed && doctrine === 'false-retreat') {
    let rally = board.facts().find(f => f.id === 'feigned-rally')
    if (!rally) { board.recordFact(team[0].id, now, { id: 'feigned-rally', kind: 'mark', position: { x: center.x - forward.x * 8, y: center.y, z: center.z - forward.z * 8 } }, 30000); rally = board.facts().find(f => f.id === 'feigned-rally') }
    if (rally && now - rally.seenAt < 8000) for (const m of available) if (!plan.has(m.id)) put(m, 'goto', { bait: true, feigned: true, target: primary.id, enemyPosition: primary.position }, rally.position)
  }
  // Фонтан: при рывке хищника строй расходится в стороны, пропуская его по коридору, а когда он проскочил середину —
  // смыкается вокруг него со всех сторон, со спины первым. Ось и середина рывка запоминаются на доске, пока он идёт.
  if (doctrine === 'fountain' && primary && now - primary.seenAt <= 1000) {
    const v = primary.velocity || { x: 0, y: 0, z: 0 }, speed = Math.hypot(v.x, v.z)
    const charging = speed * 20 > 2.5 && v.x * (center.x - primary.position.x) + v.z * (center.z - primary.position.z) > 0
    let anchor = board.facts().find(f => f.id === 'fountain-anchor'), heading = board.facts().find(f => f.id === 'fountain-axis')
    if ((!anchor || !heading) && charging) {
      board.recordFact(team[0].id, now, { id: 'fountain-anchor', kind: 'mark', position: { ...center } }, 12000)
      board.recordFact(team[0].id, now, { id: 'fountain-axis', kind: 'mark', position: { x: center.x + v.x / speed, y: center.y, z: center.z + v.z / speed } }, 12000)
      anchor = board.facts().find(f => f.id === 'fountain-anchor'); heading = board.facts().find(f => f.id === 'fountain-axis')
    }
    // Идёт к нам, но ещё не рывком — коридор раскрывается заранее по линии «он — середина строя» (лаборатория 13.10: до
    // рывка строй бежал ему навстречу). Стоит на месте — обычный бой вразброс, без раскрытия.
    const toUs = Math.hypot(center.x - primary.position.x, center.z - primary.position.z) || 1
    const pre = !anchor && v.x * (center.x - primary.position.x) + v.z * (center.z - primary.position.z) > 0
      ? { a: center, ax: { x: (center.x - primary.position.x) / toUs, z: (center.z - primary.position.z) / toUs } } : null
    if ((anchor && heading) || pre) {
      const a = pre ? pre.a : anchor!.position, ax = pre ? pre.ax : { x: heading!.position.x - a.x, z: heading!.position.z - a.z }
      const lateral = { x: -ax.z, z: ax.x }
      const progress = (primary.position.x - a.x) * ax.x + (primary.position.z - a.z) * ax.z
      const school = available.filter(m => !plan.has(m.id))
      if (progress < 1.5) {
        // Пробка (14.10): один встаёт в коридоре в 7 бл. за серединой — рывок упирается в него, и строй смыкается вокруг,
        // а не догоняет со спины (лаборатория run11: прорвавшийся бежал дальше, все сомкнулись только сзади). Со щитом —
        // щит к нему; без щита — самый крепкий. Нужны хотя бы двое на коридор по бокам.
        const cork = school.length >= 3 ? school.slice().sort((p, q) => Number(hasShield(q)) - Number(hasShield(p)) || q.health * q.strength - p.health * p.strength)[0] : undefined
        if (cork) put(cork, 'goto', { fountain: 'cork', ...(hasShield(cork) ? { hold: 'shield', face: { x: primary.position.x, y: primary.position.y + 1.6, z: primary.position.z } } : {}), range: .6, target: primary.id, enemyPosition: primary.position },
          { x: a.x + ax.x * 7, y: cork.position.y, z: a.z + ax.z * 7 })
        // Каждый уходит на свою сторону коридора и на шаг дальше, чем стоит: коридор — не уже 5 бл. от оси.
        const s = (m: SwarmMember) => (m.position.x - a.x) * lateral.x + (m.position.z - a.z) * lateral.z
        const ranks = new Map<number, number>()
        for (const [i, m] of school.filter(m => m !== cork).sort((p, q) => Math.abs(s(p)) - Math.abs(s(q))).entries()) {
          const sign = s(m) > .3 ? 1 : s(m) < -.3 ? -1 : i % 2 ? 1 : -1
          const rank = ranks.get(sign) || 0; ranks.set(sign, rank + 1)
          const out = sign * Math.max(Math.abs(s(m)) + 1.5, 5 + rank * 1.5)
          const along = Math.max(-6, Math.min(2, (m.position.x - a.x) * ax.x + (m.position.z - a.z) * ax.z))
          put(m, 'goto', { fountain: 'open', range: .5, target: primary.id, enemyPosition: primary.position }, { x: a.x + ax.x * along + lateral.x * out, y: m.position.y, z: a.z + ax.z * along + lateral.z * out })
        }
      } else {
        // Смыкание: места по кругу 2.5 бл. от него, первое — прямо за спиной (против хода рывка).
        const back = Math.atan2(-ax.z, -ax.x), n = school.length
        const slots = Array.from({ length: n }, (_, k) => back + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 2 * Math.PI / Math.max(3, n))
        const taken = new Set<number>()
        for (const m of school.sort((p, q) => distance(p.position, primary.position) - distance(q.position, primary.position))) {
          const angle = Math.atan2(m.position.z - primary.position.z, m.position.x - primary.position.x)
          const k = slots.map((t, j) => ({ j, d: Math.abs(Math.atan2(Math.sin(t - angle), Math.cos(t - angle))) })).filter(o => !taken.has(o.j)).sort((p, q) => p.d - q.d)[0].j
          taken.add(k)
          put(m, 'fight', { fountain: 'close', target: primary.id, enemyPosition: primary.position }, { x: primary.position.x + Math.cos(slots[k]) * 2.5, y: primary.position.y, z: primary.position.z + Math.sin(slots[k]) * 2.5 })
          loads.set(primary.id, (loads.get(primary.id) || 0) + 1)
        }
      }
    }
  }
  const meanStrength = team.reduce((s, m) => s + m.strength, 0) / team.length || 1
  const hidden = new Map<number, number>()
  // Окружение (пользователь 14.10: «окружать по всей карте — делиться на части, заходить с разных сторон, сужаться и
  // добивать»; «кучкуются в точке, когда пытаются ко мне пройти, — зельями и молнией их толпой»): у каждого, кто идёт на
  // цель, свой из 8 секторов вокруг неё — ближайший к его пеленгу свободный (занятый — дороже), так кольцо ровное и маршруты
  // разные (с крыши к нему лезут с восьми сторон, а не одной кучей у подножия). Обрыв у цели (edgeOf — сторона, где падение)
  // — сектора напротив него дешевле: удар отбрасывает от бьющего, то есть в обрыв (пользователь 14.10: «если рядом обрыв —
  // всегда пытаться скинуть, это приоритетный способ убить»).
  const SECTORS = 8
  const sectorsTaken = new Map<string, number[]>()
  const edges = new Map<string, { x: number; z: number } | null>()
  function sectorOf(m: SwarmMember, foe: SharedEnemy): number {
    const own = sectorsTaken.get(foe.id) || []; sectorsTaken.set(foe.id, own)
    if (!edges.has(foe.id)) edges.set(foe.id, options.edgeOf?.(foe.position) ?? null)
    const edge = edges.get(foe.id)
    const bearing = Math.atan2(m.position.z - foe.position.z, m.position.x - foe.position.x)
    let best = 0, bestCost = Infinity
    for (let k = 0; k < SECTORS; k++) {
      const a = k * 2 * Math.PI / SECTORS
      const turn = Math.abs(((a - bearing) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI)
      const cost = turn + (edge ? (Math.cos(a) * edge.x + Math.sin(a) * edge.z) * 4 : 0) + own.filter(x => x === k).length * 3
      if (cost < bestCost) { bestCost = cost; best = k }
    }
    own.push(best)
    return best
  }
  const ringAt = (foe: SharedEnemy, k: number, r: number): SwarmPosition => ({ x: foe.position.x + Math.cos(k * 2 * Math.PI / SECTORS) * r, y: foe.position.y, z: foe.position.z + Math.sin(k * 2 * Math.PI / SECTORS) * r })
  // Работа на команду (пользователь 14.10: «блоков нет — слабых, необутанных отправить добывать песок, несколько, чтобы
  // быстрее; любая задача оценивается в число игроков, которые будут её решать»): цель наверху, лезущим не хватает блоков
  // (дефицит считает драйвер по их нуждам) — рабочих дефицит / 32, до 4; из слабых, кто дальше 10 бл. от врагов, ближние к
  // месту добычи. Добытое разносят передачи (нужды бойцов).
  const gatherers = new Set(aggressive && options.gather && options.gather.deficit > 0
    ? team.filter(m => weak(m) && enemies.every(e => distance(e.position, m.position) > 10)).sort((a, b) => distance(a.position, options.gather!.spot) - distance(b.position, options.gather!.spot))
      .slice(0, Math.min(4, Math.ceil(options.gather.deficit / 32))).map(m => m.id) : [])
  // Охота (пользователь 14.10: бой должен кончаться): врагов не видно — к месту, где их видели последним (60 с), а там
  // прочёсывать; лут — только тому, кому нечем драться.
  // Последнее место врага — с его высотой (по ней прокоп к замуровавшемуся; высота своих уводила прокоп в пол) и на 3 мин.:
  // человек в коробке сидит дольше минуты (пользователь 15.10: «уничтожение кемпера с поиском»).
  // Место — самого свежего врага, а не середина нескольких (Codex 15.10: враги по бокам — середина под ботом, прокоп под себя).
  if (enemies.length) board.recordFact(team[0].id, board.now(), { id: 'last-enemy', kind: 'mark', position: { ...[...enemies].sort((a, c) => c.seenAt - a.seenAt)[0].position } }, 180000)
  const lastEnemy = enemies.length ? undefined : board.facts().find(f => f.id === 'last-enemy')
  for (const ally of hurt) {
    const foe = enemies.filter(e => !untouchable.has(e.id) && (aimingAt({ name: e.id, p: e.position, v: e.velocity }, { name: ally.id, p: ally.position }) || distance(e.position, ally.position) < 12)).sort((a, b) => distance(a.position, ally.position) - distance(b.position, ally.position))[0]
    const guard = foe && team.filter(m => !plan.has(m.id) && !(aggressive && weak(m))).sort((a, b) => (b.strength / meanStrength) * 6 - distance(b.position, ally.position) - ((a.strength / meanStrength) * 6 - distance(a.position, ally.position)))[0]
    if (guard && foe) {
      const search = board.now() - foe.seenAt > 500
      put(guard, search ? 'goto' : 'fight', { target: foe.id, enemyPosition: foe.position, cover: ally.id, search }, search ? foe.position : spots.get(guard.id))
      loads.set(foe.id, (loads.get(foe.id) || 0) + guard.strength / meanStrength)
    }
  }
  // shortcut: greedy allocation is quadratic in actors×targets; use matching only if farm profiling calls for it.
  // Ямы-ловушки (пользователь 14.10: «разбирать колизей — наделать дырок алмазной и незеритовой киркой, скидывать туда
  // врагов; пока одни копают, другие прикрывают, потом у дыр стоять и поджидать»): враг на полу над пустотой (галерея,
  // крыша-терраса — места даёт драйвер по модели, digSites) — двое с кирками (незерит, алмаз первыми), не в схватке,
  // вскрывают пол в 2–5 бл. от него; прикрывают все остальные (бой идёт), а дыры драйвер отдаёт в edgeOf — сектор удара
  // ставит бьющих так, чтобы отбросило в дыру.
  // Кто уже на деле (прошлый план): тот и остаётся, пока дело живо — иначе каждые полсекунды копатель становился кемпером,
  // потом бойцом, потом снова копателем («смена фазы — обрываю дело», арена 36: пользователь «рой тупее прошлого»).
  const held = (key: string) => new Map(board.tasks().filter(t => t.assignedTo && t.data?.[key] !== undefined && t.position).map(t => [t.assignedTo!, t.position!]))
  // Цели — свежие, быстрые первыми; по 1–2 копателя на цель (несколько целей), ямы впереди его хода, разнос 3 бл. (Codex 15.10:
  // все копатели доставались первой цели — 4/0/0 вместо 1/1/2).
  const diggers = new Map<string, { site: SwarmPosition; foe: SharedEnemy }>()
  if (aggressive && options.digSites) {
    const speed = (e: SharedEnemy) => Math.hypot(e.velocity?.x || 0, e.velocity?.z || 0)
    const goals = enemies.filter(e => board.now() - e.seenAt < 5000).sort((a, b) => speed(b) - speed(a) || b.seenAt - a.seenAt || a.id.localeCompare(b.id))
    const pickTier = (m: SwarmMember) => Math.max(0, ...Object.keys(m.inventory || {}).filter(n => count(m.inventory, n) > 0).map(n => n === 'netherite_pickaxe' ? 3 : n === 'diamond_pickaxe' ? 2 : /_pickaxe$/.test(n) ? 1 : 0))
    // Кирки у многих (пользователь 15.10: «выдай всем незеритовые кирки — больше ям») — до четырёх копателей.
    const limit = Math.min(4, 2 + Math.floor(team.filter(m => pickTier(m) > 0).length / 10))
    // Кто уже копает — остаётся у своей ямы и цели (иначе «смена фазы — обрываю дело» каждые полсекунды).
    const was = new Map(board.tasks().filter(t => t.assignedTo && t.data?.dig && t.position).map(t => [t.assignedTo!, t]))
    const taken: SwarmPosition[] = []
    const jobs = goals.map(foe => {
      const v = foe.velocity
      const ahead = (s: SwarmPosition) => (s.x + .5 - foe.position.x) * (v?.x || 0) + (s.z + .5 - foe.position.z) * (v?.z || 0)
      return { foe, sites: options.digSites!(foe.position).sort((a, b) => ahead(b) - ahead(a) || distance(a, foe.position) - distance(b, foe.position)) }
    })
    for (let round = 0; round < (jobs.length > 1 ? 2 : limit); round++) for (const { foe, sites } of jobs) {
      if (diggers.size >= limit) break
      // Как в исполнителе: в контакте — бой; яму копаем с текущего места.
      const pool = team.filter(m => !plan.has(m.id) && !diggers.has(m.id) && (was.has(m.id) || !weak(m)) && enemies.every(e => distance(e.position, m.position) > 3.5))
        .sort((a, b) => Number(was.get(b.id)?.data?.target === foe.id) - Number(was.get(a.id)?.data?.target === foe.id) || pickTier(b) - pickTier(a) || distance(a.position, foe.position) - distance(b.position, foe.position))
      for (const m of pool) {
        // Без кирки — руками (песчаник 0.8: 4 с на блок, яма в два — 8 с): кирки первыми, но яма не ждёт кирку.
        const under = (q: SwarmPosition, s: any) => Math.abs(q.y - (s.feetY ?? s.y + 1)) <= .6 && !(q.x + .3 <= s.x || q.x - .3 >= s.x + 1 || q.z + .3 <= s.z || q.z - .3 >= s.z + 1)
        const fits = (s: any) => !taken.some(q => Math.abs(q.y - s.y) < 2 && Math.hypot(q.x - s.x, q.z - s.z) < 3) && canDigTrap(m.position, s) && !team.some(a => a.id !== m.id && under(a.position, s)) && (pickTier(m) > 0 || !(s.handMs > 12000))
        const old = was.get(m.id)
        const s = sites.find(s => old?.data?.target === foe.id && cellKey(s) === cellKey(old.position!) && fits(s)) || sites.find(fits)
        if (!s) continue
        taken.push(s); diggers.set(m.id, { site: s, foe })
        break
      }
    }
  }
  // Лестница для команды (пользователь 14.10: «лестница, по которой залезут другие, ценнее одноразового столба; дерево —
  // крафтить лестницы»): столб, что построил свой лезущий у цели наверху (ladderSites — драйвер), — один на столб (до
  // двух): ближний, у кого лестниц и брёвен хватит на высоту (бревно ≈ 3 лестницы), не в схватке.
  const ladderers = new Map<string, { key: string; x: number; y: number; z: number; top: number; face: { x: number; z: number } }>()
  // Место — у стены пояса между ботом и целью (верх не выше цели, по горизонтали в 12 бл. от неё); снизу вверх, ближние к цели
  // первыми; до двух сразу. Хватит ли — лестницы + из дерева (7 палок → 3 лестницы; доска → 2 палки; бревно → 4 доски; верстак
  // — 4 доски, если его нет).
  if (aggressive) {
    const goals = enemies.filter(e => board.now() - e.seenAt < 15000)
    const nearGoal = (s: SwarmPosition) => Math.min(...goals.map(e => Math.hypot(e.position.x - s.x, e.position.z - s.z)))
    const sites = (options.ladderSites || []).filter(s => goals.some(e => s.top + 1 <= e.position.y + 1 && e.position.y - s.y >= 3) && nearGoal(s) < 12)
      .sort((a, c) => a.y - c.y || nearGoal(a) - nearGoal(c))
    for (const site of sites) {
      if (ladderers.size >= 2) break
      const need = site.top - site.y + 1
      const enough = (m: SwarmMember) => {
        const planks = count(m.inventory, 'oak_planks') + 4 * count(m.inventory, 'oak_log')
        const sticks = count(m.inventory, 'stick') + 4 * Math.floor(Math.max(0, planks - (count(m.inventory, 'crafting_table') ? 0 : 4)) / 2)
        return count(m.inventory, 'ladder') + 3 * Math.floor(sticks / 7) >= need
      }
      const m = team.filter(a => !plan.has(a.id) && enough(a) && Math.abs(a.position.y - site.y) <= 1.5 && !diggers.has(a.id) && !ladderers.has(a.id) && ![...ladderers.values()].some(l => l.key === site.key) &&
        enemies.every(e => distance(e.position, a.position) > 6)).sort((a, c) => distance(a.position, site) - distance(c.position, site))[0]
      if (m) ladderers.set(m.id, site)
    }
  }
  // Кемперы (пользователь 14.10: «архетипы — кемперы по углам колизея, прячутся, поджидают; если их начинают раскапывать —
  // резко атаковать»): при большом перевесе (живых ≥ 8 на врага, не штурм) — каждый десятый из снаряжённых, кто дальше 20 бл.
  // от врагов, сидит на шифте в своём тупике колизея (campSpots, ближний к нему из тех, что в 12+ бл. от врагов). Враг
  // подошёл на 20 — кемпер выходит из засады в обычный план (бой — когда тот в 4.5, сектор — как у всех).
  const campers = new Map<string, SwarmPosition>()
  // Штурм новых кемперов не ставит, а сидящих не снимает: засада — поджидать, а не бежать на общий штурм (стенд 15.10: все три
  // кемпера разом «→ fight» на штурме, ни одной коробки).
  if (aggressive && options.campSpots?.length && enemies.length && team.length >= 8 * enemies.length) {
    const was = held('camp')
    // Тупик, где толпятся свои (спавн в начале раунда, сундуки), — не засада: там не спрятаться и не замуроваться.
    // Свою засаду кемпер не теряет из-за прохожего (стенд 15.10: свой прошёл мимо коробки — кемпер «в бой» и лез из неё по кругу).
    const own = new Set([...was.values()].map(cellKey))
    const spots = options.campSpots.filter(s => enemies.every(e => distance(e.position, s) > 12) && (own.has(cellKey(s)) || !team.some(a => !was.has(a.id) && distance(a.position, s) < 4)))
    const pool = team.filter(m => (!assault || was.has(m.id)) && !weak(m) && !enemies.some(e => outclassed(m, e)) && !diggers.has(m.id) && !ladderers.has(m.id) && enemies.every(e => distance(e.position, m.position) > 20))
      .sort((a, b) => Number(was.has(b.id)) - Number(was.has(a.id)) || a.id.localeCompare(b.id))
    for (const m of pool.slice(0, Math.floor(team.length / 10))) {
      const old = was.get(m.id), i = old ? spots.findIndex(x => cellKey(x) === cellKey(old)) : -1
      const s = i >= 0 ? spots.splice(i, 1)[0] : spots.sort((a, b) => distance(a, m.position) - distance(b, m.position)).shift()
      if (s) campers.set(m.id, s)
    }
  }
  for (const m of team.filter(m => !plan.has(m.id)).sort((a, b) => b.strength - a.strength || a.id.localeCompare(b.id))) {
    if (diggers.has(m.id)) { const { site: s, foe } = diggers.get(m.id)!; put(m, 'goto', { dig: cellKey(s), blocks: (s as any).blocks, stands: (s as any).stands, target: foe.id, enemyPosition: foe.position, reason: 'копаю яму-ловушку' }, s); continue }
    if (ladderers.has(m.id)) { const s = ladderers.get(m.id)!; put(m, 'goto', { ladder: s.key, reason: 'ставлю лестницу для своих' }, { x: s.x, y: s.y, z: s.z }); continue }
    if (campers.has(m.id)) { put(m, 'goto', { hold: 'ambush', camp: cellKey(campers.get(m.id)!), reason: 'засада в углу' }, campers.get(m.id)!); continue }
    const foe = hunting(m) && !untouchable.has(prey!.id) ? prey! : [...enemies].filter(e => !untouchable.has(e.id)).sort((a, b) => targetCost(m, a) - targetCost(m, b) || a.id.localeCompare(b.id))[0]
    if (!foe && untouchable.size) { put(m, 'goto', { reserve: true, sentry: true }, m.position); continue }
    const nearGap = enemies.length ? Math.min(...enemies.map(e => distance(e.position, m.position))) : Infinity
    // Уже на насесте (элитры) — сидеть на нём, а не перелетать.
    const onPerch = (options.perches || []).some(q => distance(q, m.position) < 2)
    if (losing && !hunting(m) && nearGap > 6) {
      const den = onPerch ? m.position : perchFor(m) ?? hideoutFor(m)
      if (den) { put(m, 'flee', { target: foe?.id, enemyPosition: foe?.position, ...(onPerch || options.perches?.includes(den) ? { perch: true } : { hide: true }), panic: true, reason: 'проигрываем — прячусь' }, den); continue }
    }
    if (!foe) {
      // Прятался, а враг пропал из виду (за стеной, вне прорисовки) — сидеть в укрытии, пока последнее место врага в 22 бл.
      // (арена 40: прятался → не видно → лут → снова виден → прятался, каждые 3–7 с).
      const was = board.tasks().find(t => t.id === `pvp:${m.id}` && t.kind === 'flee' && t.position)
      if (was && lastEnemy && board.now() - lastEnemy.seenAt < 6000 && distance(lastEnemy.position, m.position) < 22) { put(m, 'flee', was.data || {}, was.position); continue }
      const improvement = improvementOf(m)
      // Врага не видели (или забыли) — недобор снаряжения добирать лутом (сундуки наверху тоже); видели — охота (Codex 15.10).
      if (weak(m) || improvement > 0 && (!lastEnemy || board.facts().some(f => f.id === 'outmatched' || f.id === 'outmatched:' + m.id))) { put(m, 'loot', { improvement, reason: 'лут: врага не видно' }); continue }
      // Врага не видели вовсе — прочёсывать, без прокопа: «охота» на своё место копала под себя (ночь 15.10: 1686 прокопов
      // в пустом раунде, ~100 ботов провалились под арену).
      const at = lastEnemy?.position ?? m.position
      put(m, 'goto', { search: true, ...(lastEnemy ? { hunt: true } : {}), enemyPosition: at, improvement }, at); continue
    }
    // Натиск, слабый (weak): ближний враг дальше 16 бл. — лут; 5–16 — к своим по открытому, за спины готовых (пользователь
    // 14.10: «не должны в замкнутые пространства бежать, когда игрок рядом за ними идёт» — комната-тупик с пустыми
    // сундуками); своих рядом нет — в укрытие колизея, там на шифте («если своих нет — прятаться в колизее, в блоках или
    // на высоте, и шифт зажимать, чтобы мы не видели»); ближе 5 бл. не убежать (он быстрее) — драться со всеми.
    // Перегруппировка после проваленного штурма — так же для всех, кто не в схватке. Голые — и в штурме (пользователь
    // 14.10: «бегут к игроку без вещей»): штурм — для снаряжённых, голому сперва лут.
    if (aggressive && !(foe === prey && hunting(m)) && (weak(m) || outclassed(m, [...enemies].sort((a, b) => distance(a.position, m.position) - distance(b.position, m.position))[0]) || regroup && !assault)) {
      const near = [...enemies].sort((a, b) => distance(a.position, m.position) - distance(b.position, m.position))[0], gap = distance(m.position, near.position)
      if (gatherers.has(m.id)) { put(m, 'goto', { gather: options.gather!.item, count: 32, reason: 'добываю блоки для подъёма' }, options.gather!.spot); continue }
      // На насесте — сидеть, пока враг в 28 бл.: оттуда лук и еда; ушёл дальше — вниз за лутом.
      // Запас по расстоянию: убегавший вернётся к луту только за 22 бл. (на 16 туда-сюда каждые 3 с — арены 37–38).
      // Память — на доске, а не в задаче: дошёл до укрытия — задача снята, и порог снова 16 (поле, s6: 24 смены за 28 с).
      // Снимается только лутом за 22 бл. — не сроком (было 15 с: убежавший за 16 с снова лутался на 17 бл. и бежал опять).
      const fled = !!fledAt.get(board)?.has(m.id)
      // Две границы: бегство — с 16 бл. и ближе, лут — только дальше 22; между ними — что было (отметка снимается с лутом,
      // иначе граница одна — 22 — и на 22↔23 бл. смена каждые 2 с, поле s8).
      if (gap > (fled ? 22 : 16) && !(onPerch && gap < 28)) { fledAt.get(board)?.delete(m.id); put(m, 'loot', { improvement: improvementOf(m), weak: true, reason: `лут: враг в ${Math.round(gap)} бл.${fled ? ' (убегал)' : ''}` }); continue }
      // Граница «не убежать» с запасом от прежней задачи (стенд rush 15.10: на 5–6 бл. «прячусь ↔ бой» каждые 1–2 с, 45 смен
      // у одного бота): убегавший дерётся только вплотную (3.5), дерущийся уходит дальше 6.
      const prior = board.tasks().find(t => t.id === `pvp:${m.id}`)?.kind
      const edge = prior === 'flee' ? 3.5 : prior === 'fight' ? 6 : 5
      const perch = gap > edge && (onPerch ? m.position : perchFor(m))
      if (perch) { markFled(board, m.id); put(m, 'flee', { target: near.id, enemyPosition: near.position, perch: true, panic: true, reason: `на насест, нечем драться (враг в ${Math.round(gap)} бл.${fled ? ', убегал' : ''})` }, perch); continue }
      const group = gap > edge && rallyFor(m, near)
      if (group) { markFled(board, m.id); put(m, 'flee', { target: near.id, enemyPosition: near.position, regroup: true, panic: true, reason: `к своим, нечем драться (враг в ${Math.round(gap)} бл.${fled ? ', убегал' : ''})` }, group); continue }
      const hide = gap > edge && hideoutFor(m)
      if (hide) { markFled(board, m.id); put(m, 'flee', { target: near.id, enemyPosition: near.position, hide: true, panic: true, reason: `прячусь, своих рядом нет (враг в ${Math.round(gap)} бл.${fled ? ', убегал' : ''})` }, hide); continue }
      // Бежать некуда (укрытия и свои — за врагом), а он ещё не вплотную — лут с отходом от него (исполнитель отходит на 8 бл.),
      // а не общий план боя: слабый шёл бы прямо на него.
      if (gap > edge) { markFled(board, m.id); put(m, 'loot', { improvement: improvementOf(m), weak: true, reason: `лут: отхожу, укрыться негде (враг в ${Math.round(gap)} бл.)` }); continue }
    }
    const nearby = distance(m.position, foe.position) <= 4.5
    // Смена линий: ранг не на смене уходит в тыл и из контакта — иначе старый фронт так и стоит в бою (лаборатория 13.10).
    if (doctrine === 'line' && lineRank(team.indexOf(m), team.length) !== lineDuty(lineClock, team.length)) {
      put(m, 'goto', { reserve: true, line: lineRank(team.indexOf(m), team.length), rotation: lineDuty(lineClock, team.length) }); continue
    }
    const demand = visibleForce(foe) * 1.2 / meanStrength
    const engageValue = (1 - (loads.get(foe.id) || 0) / demand) * 15 + 7 - distance(m.position, foe.position) * 0.25
    const reserveValue = (m.role === 'miner-builder' ? 8 : m.role === 'healer' ? 6 : 1) + (1 - ratio(m)) * 8
    // Натиск: резерва нет — на человека идут все (резерв «по модели нужно 2–3» оставлял одиночек без подмоги).
    if (!nearby && !aggressive && engageValue < reserveValue) {
      const i = team.indexOf(m); const across = (i - (team.length - 1) / 2) * 2
      const at = doctrine === 'ring' || doctrine === 'weak-center' ? spots.get(m.id) : { x: center.x - forward.x * 5 - forward.z * across, y: m.position.y, z: center.z - forward.z * 5 + forward.x * across }
      put(m, m.role === 'miner-builder' ? 'scout' : 'goto', { reserve: true, sentry: true }, at)
      continue
    }
    const search = board.now() - foe.seenAt > 500
    // Натиск: не в одиночку (пользователь 14.10: «в одиночку прибегают бить двух жёстких игроков»), но и без хоровода
    // («бегают вокруг игроков и не атакуют сразу — мирные как будто»; кольцо ожидания в 14 бл. так и выглядело). Сразу в бой:
    // кто-то из своих уже в схватке с целью, у цели (в 16 бл.) набралось по двое на каждого её врага (не меньше трёх, не
    // больше всех готовых), цель ослабла (ва-банк) или сама идёт на него. Иначе — к ближним готовым своим (до трёх, не у
    // цели): собраться, а не кружить; своих нет — в бой.
    const gapFoe = distance(m.position, foe.position)
    if (aggressive && !search && gapFoe > 8 && foe !== prey) {
      const ready = team.filter(a => a.id !== m.id && !weak(a) && !['flee', 'recover', 'heal'].includes(plan.get(a.id)?.kind ?? ''))
      const engaged = ready.some(a => distance(a.position, foe.position) <= 8)
      const staged = ready.filter(a => distance(a.position, foe.position) <= 16).length + (gapFoe <= 16 ? 1 : 0)
      const need = Math.min(ready.length + 1, Math.max(3, 2 * enemies.filter(e => distance(e.position, foe.position) <= 12).length))
      const v = foe.velocity || { x: 0, y: 0, z: 0 }
      const coming = ((m.position.x - foe.position.x) * v.x + (m.position.z - foe.position.z) * v.z) / gapFoe > 0.1
      // Сбор — на своём секторе кольца в 10 бл. от цели (не в кучке у своих: кучку у подножия выбивали зельем и молнией).
      if (!engaged && staged < need && !coming && Math.abs(foe.position.y - m.position.y) < 4) {
        const k = sectorOf(m, foe)
        put(m, 'goto', { target: foe.id, enemyPosition: foe.position, sentry: true, stage: `s${k}`, slot: k }, ringAt(foe, k, 10))
        continue
      }
    }
    // Натиск: бой — прямо на цель, а не на место в строю (строй ползёт за толпой, и бойцы кружили вокруг человека, 14.10).
    // Натиск: место — свой сектор в 2.5 бл. от цели (окружение): драйвер ведёт туда, пока до места дальше 6 бл., потом бой.
    const slot = aggressive && !search ? sectorOf(m, foe) : undefined
    put(m, search || !(committed || nearby) ? 'goto' : 'fight', { target: foe.id, enemyPosition: foe.position, sentry: !committed, search, push: doctrine === 'wave' && count(m.inventory, 'wind_charge') > 2 && !count(m.inventory, 'mace'), ...(assault ? { assault: true } : {}), ...(slot !== undefined ? { slot } : {}) }, search ? foe.position : slot !== undefined ? ringAt(foe, slot, 2.5) : aggressive ? foe.position : spots.get(m.id))
    loads.set(foe.id, (loads.get(foe.id) || 0) + m.strength / meanStrength)
  }
  // Укрытие для слабого: дальше от врагов, чем он сам (не навстречу), ближе к нему; занятые другими — дороже (расходятся).
  function hideoutFor(m: SwarmMember): SwarmPosition | null {
    const near = (p: SwarmPosition) => Math.min(...enemies.map(e => distance(p, e.position)))
    const mine = near(m.position)
    let best = -1, bestScore = -Infinity
    for (const [i, h] of (options.hideouts || []).entries()) {
      if (enemies.length && near(h) <= mine + 2 && !(distance(h, m.position) < 3 && near(h) > 6)) continue
      // Укрытие за врагом не годится: путь к нему идёт мимо него (поле s13: прячусь → бег через красного → 24 → 14 бл.).
      const e0 = enemies.length ? [...enemies].sort((a, c) => distance(a.position, m.position) - distance(c.position, m.position))[0] : null
      if (e0 && distance(h, m.position) > 3 && (h.x - m.position.x) * (m.position.x - e0.position.x) + (h.z - m.position.z) * (m.position.z - e0.position.z) < 0) continue
      const score = Math.min(near(h), 30) - .5 * distance(h, m.position) - 6 * (hidden.get(i) || 0)
      if (score > bestScore) { bestScore = score; best = i }
    }
    if (best < 0) return null
    hidden.set(best, (hidden.get(best) || 0) + 1)
    return options.hideouts![best]
  }
  // Насест для бегства на элитрах (пользователь 14.10: «убегают плохо на элитре — только по арене внизу, хотя могут наверх
  // улетать и там сидеть, кемперить или с лука палить»): элитры (надеты или в рюкзаке) и 3+ ракеты; насест (верх яруса,
  // вершина колизея) — дальше 12 бл. от врагов; дальше от них, выше и ближе к нему — лучше, занятый другим — дороже.
  function perchFor(m: SwarmMember): SwarmPosition | null {
    const worn = (Array.isArray(m.armor) ? m.armor : Object.values(m.armor || {})).includes('elytra')
    if (!options.perches?.length || !(worn || count(m.inventory, 'elytra') > 0) || count(m.inventory, 'firework_rocket') < 3) return null
    let best = -1, bestScore = -Infinity
    for (const [i, p] of options.perches.entries()) {
      const near = Math.min(...enemies.map(e => distance(p, e.position)))
      if (near < 12) continue
      const score = Math.min(near, 28) + (p.y - m.position.y) * .3 - distance(p, m.position) * .15 - 8 * (perched.get(i) || 0)
      if (score > bestScore) { bestScore = score; best = i }
    }
    if (best < 0) return null
    perched.set(best, (perched.get(best) || 0) + 1)
    return options.perches[best]
  }
  // Свои для слабого: самая плотная кучка готовых (двое и больше в 8 бл.) в 24 бл. от него и не ближе к врагу, чем он сам
  // (или 8 бл.): навстречу врагу — не к своим; точка — в 3 бл. за кучкой, по другую сторону от врага.
  function rallyFor(m: SwarmMember, foe: SharedEnemy): SwarmPosition | null {
    const gap = distance(m.position, foe.position)
    // Свои — и слабые: толпа у него на пути бьёт со спины, а одиночку он догоняет (Codex 15.10, стенд rush).
    const ready = team.filter(a => a.id !== m.id && distance(a.position, foe.position) >= Math.min(gap, 8) && distance(a.position, m.position) <= 24)
    const packs = ready.map(a => ready.filter(o => distance(o.position, a.position) <= 8)).filter(pack => pack.length >= 2)
    const pack = packs.sort((p, q) => q.length * 3 - distance(q[0].position, m.position) * .2 - (p.length * 3 - distance(p[0].position, m.position) * .2))[0]
    if (!pack) return null
    const c = { x: pack.reduce((s, a) => s + a.position.x, 0) / pack.length, z: pack.reduce((s, a) => s + a.position.z, 0) / pack.length }
    // Свои за врагом — не убежище: путь к ним идёт мимо него (как с укрытиями, поле s14).
    if (Math.hypot(c.x - m.position.x, c.z - m.position.z) > 3 && (c.x - m.position.x) * (m.position.x - foe.position.x) + (c.z - m.position.z) * (m.position.z - foe.position.z) < 0) return null
    const d = Math.hypot(c.x - foe.position.x, c.z - foe.position.z) || 1
    return { x: c.x + (c.x - foe.position.x) / d * 3, y: m.position.y, z: c.z + (c.z - foe.position.z) / d * 3 }
  }
  // Слабый — нечем драться: improvementOf > 4 или брони меньше 8 очков (меньше железных шлема и нагрудника). С одним
  // каменным топором improvementOf ровно 4 (8 − 9 → 0, броня 0 → 4), и такой бот голосовал за штурм и шёл на людей
  // (пользователь 14.10: «у бота, который пришёл, ничего почти не было из вещей»).
  // Порог мягче (15.10, лут по ярусам: внизу кожа и кольчуга — с «броня < 8» рой минуту лутался вместо атаки, «вяло идут»):
  // нет оружия, броня < 3 или совсем пусто (improvementOf > 7). Каменный меч и кожаная куртка — уже боец; топор без брони — нет.
  // Переигран (пользователь 15.10: «слабые вступают в бой с сильным, который к ним на спавн подбегает, — и помирают»): по
  // видимому (шкала visibleForce — материал оружия и брони, как он видит нас и мы его) враг вдвое сильнее. После первого
  // сундука (кожа, каменный меч) бот уже не слабый, а незерит убивает его за 2–4 удара (стенд rush 15.10: 8 из 8 убитых —
  // так). Такой — как слабый: лут вдали, к своим; бой — загнанным (ближе 5 бл.) или в штурме.
  function outclassed(m: SwarmMember, foe: SharedEnemy | undefined): boolean {
    if (!foe || !m.inventory) return false
    const weapon = [m.weapon, ...Object.keys(m.inventory).filter(n => count(m.inventory, n) > 0 && damage.isMeleeWeapon(n))].filter(Boolean)
      .sort((a, b) => damage.attackDamage(b) - damage.attackDamage(a))[0]
    const armor = (Array.isArray(m.armor) ? m.armor : Object.values(m.armor || {})).filter(Boolean) as string[]
    if (visibleForce(foe) < 2 * visibleForce({ equipment: { weapon, armor } } as SharedEnemy)) return false
    const group = groups.find(g => g.includes(m))!
    let victories = groupVictories.get(group)
    if (!victories) {
      const ready = group.filter(a => !weak(a))
      const foes = enemies.filter(e => ready.some(a => distance(a.position, e.position) <= 40))
      const fight = assessTeamFight(ready, foes)
      victories = new Set(fight.wipedThem && !fight.wipedUs ? foes.map(e => e.id) : [])
      groupVictories.set(group, victories)
    }
    return !victories.has(foe.id)
  }
  function weak(m: SwarmMember): boolean { return !!m.inventory && (!Object.keys(m.inventory).some(n => count(m.inventory, n) > 0 && damage.isMeleeWeapon(n)) || ownDefense(m).armor < 3 || improvementOf(m) > 7) }
  // Насколько боту нужен лут: оружие слабее незеритового меча и недостающая броня (0 — экипирован).
  function improvementOf(m: SwarmMember): number {
    const weapon = Math.max(1, ...Object.keys(m.inventory || {}).filter(n => count(m.inventory, n) > 0 && damage.isMeleeWeapon(n)).map(n => damage.attackDamage(n)))
    return m.inventory ? Math.max(0, 8 - weapon) + Math.max(0, 20 - ownDefense(m).armor) / 5 : 0
  }
  function targetCost(m: SwarmMember, e: SharedEnemy): number {
    const local = team.filter(a => distance(a.position, e.position) < 12).reduce((s, a) => s + a.strength, 0) / meanStrength
    const enemyCrowd = enemies.filter(o => distance(o.position, e.position) < 8).length
    const enemyCenterD = Math.hypot(e.position.x - foeCenter.x, e.position.z - foeCenter.z)
    const ranged = m.role === 'ranged' ? Math.abs(distance(m.position, e.position) - 12) : distance(m.position, e.position)
    return ranged + (loads.get(e.id) || 0) * 5 + enemyCrowd * 2 - local * 2 - (m.role === 'flank' ? Math.min(8, enemyCenterD) : 0)
  }
  const previous = board.tasks().filter(t => t.id.startsWith('pvp:'))
  for (const old of previous) if (![...plan.values()].some(t => t.id === old.id)) board.cancel(old.id)
  for (const [id, task] of plan) {
    const old = previous.find(t => t.id === task.id)
    const unchanged = old?.claim && old.kind === task.kind && ['target', 'ally', 'cover', 'doctrine', 'role', 'committed', 'search', 'reserve', 'panic', 'hold', 'ambush', 'fountain', 'stage', 'regroup', 'hide', 'kite', 'perch', 'gather', 'slot', 'dig', 'camp', 'ladder'].every(key => old.data?.[key] === task.data?.[key])
    if (unchanged) { plan.set(id, old); continue }
    if (old?.status === 'done') board.cancel(old.id)
    plan.set(id, board.upsert(task))
  }
  return plan
}

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
  for (const recipient of team) for (const item of Object.keys(recipient.needs || {})) {
    const deficit = count(recipient.needs, item) - count(recipient.inventory, item)
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
